# perses-panel-preview

A GitHub Action that draws a sample image of a [Perses](https://perses.dev) panel plugin, light and dark, so the plugin's README can show what it looks like.

It builds a minimal host page from Perses's own dashboard parts, loads the plugin's built module, draws one panel from a sample file you keep in the plugin's repository, and screenshots it with Playwright's Chromium. The sample holds the panel's spec and the results its queries would return, so no datasource, network or Perses server is involved: the page is served from inside the browser and every outside request is blocked.

- Deterministic: a fixed time range from the sample (and "now" is its end), animations off, Inter bundled, device scale factor 2, UTC, `en-US`.
- Fails loudly: a query that errors, a panel that shows Perses's error alert, an ECharts "No data" state, a script error, or a panel body that is blank each fail the step.
- Fast: Perses's packages and Chromium are cached, and one job renders both themes.

## Use

Build the plugin, then run the action:

```yaml
jobs:
  preview:
    runs-on: ubuntu-latest
    permissions:
      contents: write # to upload to the release
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: pulzar-net/perses-panel-preview@v1
        with:
          plugin-dir: dist
      - run: gh release upload "$TAG" preview-*.png --clobber
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.ref_name }}
```

then point the README at the release's files, which `latest` always resolves:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/OWNER/REPO/releases/latest/download/preview-dark.png">
  <img alt="The panel" src="https://github.com/OWNER/REPO/releases/latest/download/preview-light.png">
</picture>
```

### Inputs

| Input | Default | |
| --- | --- | --- |
| `plugin-dir` | `.` | The built plugin: the folder holding `lib/index.js` (a Perses plugin's `dist/`), or a repository root where `dist/lib/index.js` exists. The plugin's own packages (a map library, a palette) are found in the `node_modules` above it. |
| `sample` | `preview/sample.json` | The sample file. |
| `width` | `900` | CSS pixels; the PNG is twice that. |
| `height` | `350` | CSS pixels, rounded up to Perses's grid (`40n - 10`: 350, 390, 430, ...). |
| `themes` | `light,dark` | One `preview-<theme>.png` per theme. |
| `output-dir` | `.` | Where the PNGs go. |

Output `files`: the paths written, one per line.

### Versions

The action pins the Perses packages the Pulzar panel repos build against (`@perses-dev/*` 0.56.0-beta.1, React 18.3, MUI 6.5, ECharts 6.1). A plugin is bundled against that one copy of each, as Perses's module federation shares them, so a plugin built for another Perses may need a release of this action pinned to it. Use `@v1`, or an exact tag.

## The sample file

`preview/sample.json`, described by [`sample.schema.json`](sample.schema.json) (add `"$schema": "https://raw.githubusercontent.com/pulzar-net/perses-panel-preview/main/sample.schema.json"` for editor help).

```json
{
  "timeRange": { "start": "2026-01-14T00:00:00Z", "end": "2026-01-15T00:00:00Z" },
  "panel": {
    "kind": "Panel",
    "spec": {
      "display": { "name": "Cold rooms" },
      "plugin": { "kind": "PulzrTimeSeriesChart", "spec": { "legend": { "position": "bottom" } } }
    }
  },
  "queries": [
    {
      "stepMs": 600000,
      "series": [
        { "name": "Room A", "points": [3.1, 3.4, 3.2, 3.9] },
        { "name": "Room B", "values": [[1768348800000, 4.0], [1768352400000, 4.2]] }
      ]
    }
  ],
  "assets": { "/style.json": "map-style-{theme}.json" }
}
```

| Field | |
| --- | --- |
| `timeRange` | `start` and `end`, ISO 8601. The panel is drawn for this range, and the page's clock reads its end. |
| `panel` | A Perses `Panel`: `spec.display` and `spec.plugin` (`kind` and `spec`, as in a dashboard). Its `queries` are not needed. |
| `queries` | The result of each query, in order. Each stands in for one query of the panel, whatever its kind. `series[]` take `name`, optional `labels`, and either `values` (`[ms, value]` pairs) or `points` (values only, `stepMs` apart from the range's start, or spread over the range when `stepMs` is left out); a `null` is a gap. `metadata` is the query's metadata, as a datasource returns it (a unit, a heatmap's `matrix`). |
| `assets` | Files the page may request, by URL path, to a path relative to the sample; `{theme}` becomes `light` or `dark`. Everything else outside the page is blocked, so a map's `styleUrl` (set it to `http://preview.invalid/style.json`) and its tiles come from here. |

## Development

```bash
npm ci
npx playwright install chromium
npm test        # renders test/fixture, a hand-written panel, and checks the failure modes
node src/render.mjs --plugin-dir test/fixture --sample test/fixture/preview/sample.json --output-dir out
```

`PREVIEW_DEBUG=1` bundles React in development mode, logs the page's `console.log`, and saves a screenshot when a panel never becomes ready.

## License

Apache 2.0.
