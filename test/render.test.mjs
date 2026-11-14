import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSample, render } from '../src/render.mjs';

const fixture = new URL('./fixture/', import.meta.url).pathname;
const run = async (sample, themes = ['light', 'dark']) => {
  const out = await mkdtemp(join(tmpdir(), 'ppp-test-'));
  try {
    return { out, files: await render({ pluginDir: fixture, samplePath: join(fixture, 'preview', sample), width: 600, height: 230, themes, outputDir: out }), read: (f) => readFile(f) };
  } catch (e) {
    await rm(out, { recursive: true, force: true });
    throw e;
  }
};

test('renders both themes to 2x PNGs', async () => {
  const { out, files, read } = await run('sample.json');
  try {
    assert.equal(files.length, 2);
    const [light, dark] = await Promise.all(files.map(read));
    assert.equal(light.subarray(1, 4).toString(), 'PNG');
    assert.equal(light.readUInt32BE(16), 1200); // 600 css px at scale 2
    assert.equal(light.readUInt32BE(20), 460); // 230 snaps to 230 on the 40n-10 grid
    assert.notDeepEqual(light, dark);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('is deterministic', async () => {
  const a = await run('sample.json', ['light']);
  const b = await run('sample.json', ['light']);
  try {
    assert.deepEqual(await a.read(a.files[0]), await b.read(b.files[0]));
  } finally {
    await Promise.all([rm(a.out, { recursive: true, force: true }), rm(b.out, { recursive: true, force: true })]);
  }
});

test('fails when the panel throws', async () => {
  process.exitCode = 0;
  await assert.rejects(run('throws.json', ['light']), /the fixture panel failed on purpose|shows an error/);
  process.exitCode = 0;
});

test('fails when the panel renders empty', async () => {
  await assert.rejects(run('blank.json', ['light']), /rendered empty/);
  process.exitCode = 0;
});

test('rejects a sample that breaks the schema', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ppp-test-'));
  try {
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ panel: {} }));
    assert.throws(() => loadSample(join(dir, 'bad.json')), /does not match sample.schema.json/);
  } finally {
    process.exitCode = 0;
    await rm(dir, { recursive: true, force: true });
  }
});
