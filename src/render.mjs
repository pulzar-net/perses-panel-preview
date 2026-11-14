#!/usr/bin/env node
/**
 * A Perses panel plugin's sample, drawn to PNGs.
 *
 *   node render.mjs --plugin-dir . --sample preview/sample.json \
 *     --width 900 --height 420 --themes light,dark --output-dir .
 *
 * The plugin's built module and a host page (host/main.tsx, Perses's own
 * dashboard parts) are bundled together by esbuild; headless Chromium opens
 * the result on an origin that exists only inside it, and every request the
 * page makes is answered here from disk. Nothing leaves the machine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ORIGIN = 'http://preview.invalid';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const THEMES = new Set(['light', 'dark']);
const READY_MS = 30_000;

export function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

/** The plugin's ESM entry, in the plugin directory as built (`lib/`, beside package.json in dist/) or at a repository root. */
export function findEntry(pluginDir) {
  const dir = resolve(pluginDir);
  const entry = ['lib/index.js', 'dist/lib/index.js'].map((p) => join(dir, p)).find(existsSync);
  if (!entry) fail(`No built plugin in ${dir}: expected lib/index.js or dist/lib/index.js (run the plugin's build first)`);
  return entry;
}

export function loadSample(path) {
  let sample;
  try {
    sample = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`Cannot read the sample ${path}: ${e.message}`);
  }
  const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(JSON.parse(readFileSync(join(ROOT, 'sample.schema.json'), 'utf8')));
  if (!validate(sample)) {
    fail(`${path} does not match sample.schema.json: ${validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
  }
  return sample;
}

/** Host page and plugin as one bundle. The packages Perses shares between host and plugin come from this action, so there is one copy of each. */
async function bundle(entry, outdir) {
  const own = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies));
  const shared = {
    name: 'one-copy',
    setup(b) {
      b.onResolve({ filter: /^plugin-under-test$/ }, () => ({ path: entry }));
      // Perses's packages are ES modules, so esbuild reads a default import of a CommonJS file as the whole exports object, as Node does. mdi-material-ui's icons are CommonJS with an ES build beside them.
      b.onResolve({ filter: /^mdi-material-ui\/[^/]+$/ }, (args) =>
        b.resolve(args.path.replace('mdi-material-ui/', 'mdi-material-ui/esm/'), { resolveDir: ROOT, kind: args.kind, pluginData: 'own' }));
      b.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === 'own') return undefined;
        const root = args.path.startsWith('@') ? args.path.split('/').slice(0, 2).join('/') : args.path.split('/')[0];
        if (!own.has(root)) return undefined;
        return b.resolve(args.path, { resolveDir: ROOT, kind: args.kind, pluginData: 'own' });
      });
    },
  };
  await build({
    entryPoints: [join(HERE, 'host/main.tsx')],
    outdir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    minify: false,
    jsx: 'automatic',
    logLevel: 'error',
    publicPath: '/',
    define: { 'process.env.NODE_ENV': process.env.PREVIEW_DEBUG ? '"development"' : '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.png': 'file', '.svg': 'file' },
    plugins: [shared],
    // A plugin's own packages (a map library, a palette) resolve from where it is installed.
    nodePaths: [join(dirname(dirname(entry)), 'node_modules'), join(dirname(dirname(dirname(entry))), 'node_modules')],
  });
  await writeFile(
    join(outdir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
  );
}

/** Fraction of the panel body's pixels unlike the most common one: a blank panel is near zero. */
async function inkOf(page, png) {
  const top = await page.evaluate(() => Math.ceil(document.querySelector('section[data-testid="panel"] > header')?.getBoundingClientRect().bottom ?? 0));
  return page.evaluate(async ([b64, top]) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // Inside the card's border and under its title.
    const { data } = ctx.getImageData(4, top * 2 + 4, bitmap.width - 8, bitmap.height - top * 2 - 8);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return 1 - Math.max(...counts.values()) / (data.length / 4);
  }, [png.toString('base64'), top]);
}

export async function render({ pluginDir, samplePath, width, height: asked, themes, outputDir }) {
  // Perses's grid is rows of 30px with 10px between, so a panel is 40n-10 tall: the height asked for, rounded up to that.
  const height = Math.ceil((asked + 10) / 40) * 40 - 10;
  if (height !== asked) console.log(`height ${asked} is ${height} on Perses's 40px grid`);
  const entry = findEntry(pluginDir);
  const sample = loadSample(samplePath);
  const sampleDir = dirname(resolve(samplePath));
  for (const theme of themes) if (!THEMES.has(theme)) fail(`themes are light and dark, not "${theme}"`);

  const work = await mkdtemp(join(tmpdir(), 'perses-panel-preview-'));
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb', '--font-render-hinting=none'],
  });
  const written = [];
  try {
    await bundle(entry, work);
    await mkdir(outputDir, { recursive: true });
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        locale: 'en-US',
        timezoneId: 'UTC',
      });
      try {
        const problems = [];
        const blocked = new Set();
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== ORIGIN) {
            blocked.add(url.origin);
            return route.abort('blockedbyclient');
          }
          const mapped = sample.assets?.[url.pathname];
          const file = mapped ? resolve(sampleDir, mapped.replaceAll('{theme}', theme)) : join(work, url.pathname === '/' ? 'index.html' : url.pathname);
          if ((!mapped && !file.startsWith(work)) || !existsSync(file)) return route.fulfill({ status: 404, body: 'Not found' });
          const ext = file.slice(file.lastIndexOf('.'));
          return route.fulfill({ body: readFileSync(file), contentType: MIME[ext] ?? 'application/octet-stream' });
        });
        const page = await context.newPage();
        // "Now" is the end of the sample's range, whatever the clock says.
        await page.clock.setFixedTime(new Date(sample.timeRange.end));
        page.on('pageerror', (e) => problems.push(`script error: ${e.message}`));
        page.on('console', (m) => (m.type() === 'error' || (process.env.PREVIEW_DEBUG && m.type() === 'log')) && console.log(`  [${theme}] console: ${m.text()}`));
        await page.addInitScript((i) => { window.__preview = i; }, { sample, dark: theme === 'dark', width, height });
        await page.goto(`${ORIGIN}/index.html`);
        try {
          await page.waitForSelector('html[data-ready]', { timeout: READY_MS });
        } catch {
          const text = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
          problems.push(`the panel was not ready after ${READY_MS / 1000}s; the page reads "${text.replace(/\s+/g, ' ')}"`);
          if (process.env.PREVIEW_DEBUG) await page.screenshot({ path: join(outputDir, `debug-${theme}.png`) });
        }
        const result = (await page.evaluate(() => window.__previewResult).catch(() => null)) ?? { failed: [], alerts: [], empty: 0 };
        for (const e of result.failed) problems.push(`a query failed: ${e}`);
        for (const a of result.alerts) problems.push(`the panel shows an error: ${a}`);
        if (result.empty) problems.push('the panel shows "No data": its sample has no series it can draw');
        const png = await page.screenshot({ type: 'png', animations: 'disabled', clip: { x: 0, y: 0, width, height } });
        if (!problems.length && (await inkOf(page, png)) < 0.003) problems.push('the panel rendered empty (almost every pixel is one color)');
        if (blocked.size) console.log(`  [${theme}] blocked requests to: ${[...blocked].join(', ')}`);
        if (problems.length) fail(`${theme}: ${problems.join('; ')}`);
        const out = join(outputDir, `preview-${theme}.png`);
        await writeFile(out, png);
        written.push(out);
        console.log(`wrote ${out} (${width * 2}x${height * 2})`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await rm(work, { recursive: true, force: true });
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'plugin-dir': { type: 'string', default: '.' },
      sample: { type: 'string', default: 'preview/sample.json' },
      width: { type: 'string', default: '900' },
      height: { type: 'string', default: '350' },
      themes: { type: 'string', default: 'light,dark' },
      'output-dir': { type: 'string', default: '.' },
    },
  });
  const size = (name, v) => (Number.isInteger(+v) && +v >= 200 && +v <= 4000 ? +v : fail(`${name} is a whole number of pixels from 200 to 4000, not "${v}"`));
  await render({
    pluginDir: values['plugin-dir'],
    samplePath: values.sample,
    width: size('width', values.width),
    height: size('height', values.height),
    themes: values.themes.split(',').map((t) => t.trim()).filter(Boolean),
    outputDir: values['output-dir'],
  }).catch((e) => {
    if (!process.exitCode) console.error(`::error::${e.stack ?? e}`);
    process.exitCode = 1;
  });
}
