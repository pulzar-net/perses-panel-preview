// A hand-written panel plugin, so the tests need no build: horizontal bars,
// one per series, from each series' last value. Two more kinds fail on purpose.
import { createElement as h } from 'react';
import packageJson from '../package.json' with { type: 'json' };

export function getPluginModule() {
  return { kind: 'PluginModule', metadata: { name: packageJson.name, version: packageJson.version }, spec: packageJson.perses };
}

const last = (s) => s.values.at(-1)?.[1] ?? 0;
const base = { supportedQueryTypes: ['TimeSeriesQuery'], panelOptionsEditorComponents: [], createInitialOptions: () => ({}) };

export const FixtureBarsPanel = {
  ...base,
  PanelComponent: ({ queryResults, contentDimensions }) => {
    const series = queryResults.flatMap((r) => r.data?.series ?? []);
    const max = Math.max(...series.map(last), 1);
    return h(
      'div',
      { style: { width: contentDimensions?.width, padding: 16, boxSizing: 'border-box', fontFamily: 'Inter' } },
      series.map((s) =>
        h('div', { key: s.name, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' } },
          h('span', { style: { width: 90 } }, s.name),
          h('div', { style: { height: 18, width: `${(last(s) / max) * 60}%`, background: '#3a7bd5' } }),
          h('span', null, String(last(s))))),
    );
  },
};

export const FixtureThrowsPanel = { ...base, PanelComponent: () => { throw new Error('the fixture panel failed on purpose'); } };
export const FixtureBlankPanel = { ...base, PanelComponent: () => null };
