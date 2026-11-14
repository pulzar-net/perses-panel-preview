/**
 * The page the action photographs: one Perses panel, drawn by Perses itself.
 *
 * `plugin-under-test` is the panel's built module (render.mjs points the
 * bundler at it). Every query the sample's panel names is replaced by
 * PreviewSampleQuery, which answers from the sample file, so the panel needs
 * no datasource, no network and no Perses server.
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { QueryParamProvider } from 'use-query-params';
import { WindowHistoryAdapter } from 'use-query-params/adapters/window';
import { ThemeProvider } from '@mui/material';
import * as echarts from 'echarts';
import { FetchProvider } from '@perses-dev/client';
import { ChartsProvider, generateChartsTheme, getTheme, SnackbarProvider } from '@perses-dev/components';
import {
  AnnotationProvider,
  Dashboard,
  DashboardProvider,
  DatasourceStoreProvider,
  PanelFocusProvider,
  VariableProviderWithQueryParams,
} from '@perses-dev/dashboards';
import { dynamicImportPluginLoader, PluginRegistry, TimeRangeProviderWithQueryParams } from '@perses-dev/plugin-system';
import * as plugin from 'plugin-under-test';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';

const input = (window as any).__preview as {
  sample: any;
  dark: boolean;
  width: number;
  height: number;
};
const { sample } = input;
const FONT = 'Inter, sans-serif';

// Charts draw their first frame at once instead of animating towards it.
echarts.registerPreprocessor((option: any) => {
  option.animation = false;
  // Canvas text has no CSS to inherit from: without this a chart that sets no font draws in the system's.
  option.textStyle = { fontFamily: FONT, ...option.textStyle };
});

/** What a sample's series become: Perses's TimeSeriesData. */
function dataOf(query: any, range: { start: Date; end: Date }) {
  const start = range.start.getTime();
  const span = range.end.getTime() - start;
  const series = (query.series ?? []).map((s: any) => {
    const count = s.points?.length ?? 0;
    const step = query.stepMs ?? (count > 1 ? span / (count - 1) : span);
    const values = s.values ?? (s.points ?? []).map((v: number | null, i: number) => [start + i * step, v]);
    return { name: s.name, ...(s.labels ? { labels: s.labels } : {}), values };
  });
  const firstPoints = (query.series ?? []).find((s: any) => s.points)?.points?.length;
  return {
    timeRange: range,
    stepMs: query.stepMs ?? (firstPoints > 1 ? span / (firstPoints - 1) : undefined),
    series,
    ...(query.metadata ? { metadata: query.metadata } : {}),
  };
}

const sampleModule = {
  getPluginModule: () => ({
    kind: 'PluginModule',
    metadata: { name: 'perses-panel-preview', version: '1.0.0' },
    spec: { plugins: [{ kind: 'TimeSeriesQuery', spec: { name: 'PreviewSampleQuery' } }] },
  }),
  PreviewSampleQuery: {
    getTimeSeriesData: async (spec: { index: number }, context: any) => dataOf(sample.queries[spec.index], context.timeRange),
    dependsOn: () => ({}),
    createInitialOptions: () => ({ index: 0 }),
  },
};

const pluginLoader = dynamicImportPluginLoader([
  { resource: (plugin as any).getPluginModule(), importPlugin: async () => plugin as any },
  { resource: sampleModule.getPluginModule() as any, importPlugin: async () => sampleModule as any },
]);

const range = { start: new Date(sample.timeRange.start), end: new Date(sample.timeRange.end) };
const ROW = 40; // a Perses grid row: 30px and a 10px gap
const rows = (input.height + 10) / ROW; // render.mjs has already snapped the height to the grid
const height = input.height;

const panel = {
  ...sample.panel,
  spec: {
    ...sample.panel.spec,
    queries: (sample.queries ?? []).map((_: unknown, index: number) => ({
      kind: 'TimeSeriesQuery',
      spec: { plugin: { kind: 'PreviewSampleQuery', spec: { index } } },
    })),
  },
};
const resource: any = {
  kind: 'Dashboard',
  metadata: { name: 'preview', project: 'preview' },
  spec: {
    display: { name: 'preview' },
    duration: '24h',
    panels: { panel },
    layouts: [
      { kind: 'Grid', spec: { items: [{ x: 0, y: 0, width: 24, height: rows, content: { $ref: '#/spec/panels/panel' } }] } },
    ],
  },
};

const datasourceApi: any = {
  getDatasource: async () => undefined,
  getGlobalDatasource: async () => undefined,
  listDatasources: async () => [],
  listGlobalDatasources: async () => [],
  buildProxyUrl: () => '',
};

/** Quiet this long, with nothing fetching, and the panel has drawn what it will. */
function Ready() {
  const client = useQueryClient();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let quietSince = performance.now();
    const timer = setInterval(() => {
      if (client.isFetching() > 0) quietSince = performance.now();
      else if (performance.now() - quietSince > 700) {
        clearInterval(timer);
        setSettled(true);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [client]);
  useEffect(() => {
    if (!settled) return;
    const failed = client
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.error)
      .map((q) => String((q.state.error as Error).message ?? q.state.error));
    void document.fonts.ready.then(() =>
      setTimeout(() => {
        const alerts = [...document.querySelectorAll('[role="alert"]')].map((el) => (el.textContent ?? '').trim());
        const empty = [...document.querySelectorAll('[_echarts_instance_]')].filter((el) => {
          const title = (echarts.getInstanceByDom(el as HTMLElement)?.getOption() as any)?.title;
          return title?.some?.((t: any) => t?.text === 'No data');
        }).length;
        (window as any).__previewResult = { failed, alerts, empty };
        document.documentElement.dataset.ready = 'true';
      }, 400),
    );
  }, [settled, client]);
  return null;
}

function App() {
  const theme = useMemo(() => {
    const t = getTheme(input.dark ? 'dark' : 'light');
    t.typography.fontFamily = FONT;
    for (const v of ['body1', 'body2', 'subtitle1', 'subtitle2', 'caption', 'button'] as const) {
      t.typography[v] = { ...t.typography[v], fontFamily: FONT };
    }
    return t;
  }, []);
  const chartsTheme = useMemo(() => generateChartsTheme(theme, {}), [theme]);
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }), []);
  return (
    <QueryClientProvider client={client}>
      <QueryParamProvider adapter={WindowHistoryAdapter}>
        <ThemeProvider theme={theme}>
          <ChartsProvider chartsTheme={chartsTheme}>
            <SnackbarProvider anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} variant="default" content="">
              <FetchProvider fetchFn={(...args) => fetch(...args)}>
                <PluginRegistry pluginLoader={pluginLoader}>
                  <DatasourceStoreProvider dashboardResource={resource} datasourceApi={datasourceApi}>
                    <DashboardProvider initialState={{ dashboardResource: resource, isEditMode: false }}>
                      <TimeRangeProviderWithQueryParams initialTimeRange={range} initialRefreshInterval="0s">
                        <VariableProviderWithQueryParams initialVariableDefinitions={[]}>
                          <AnnotationProvider initialAnnotationSpecs={[]}>
                            <PanelFocusProvider>
                              <div id="frame">
                                <Dashboard />
                              </div>
                            </PanelFocusProvider>
                            <Ready />
                          </AnnotationProvider>
                        </VariableProviderWithQueryParams>
                      </TimeRangeProviderWithQueryParams>
                    </DashboardProvider>
                  </DatasourceStoreProvider>
                </PluginRegistry>
              </FetchProvider>
            </SnackbarProvider>
          </ChartsProvider>
        </ThemeProvider>
      </QueryParamProvider>
    </QueryClientProvider>
  );
}

const theme = getTheme(input.dark ? 'dark' : 'light');
document.body.style.background = theme.palette.background.default;
// The panel fills the frame exactly, whatever the grid's rows come to.
const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; padding: 0; overflow: hidden; font-family: ${FONT}; }
  #frame { width: ${input.width}px; height: ${height}px; overflow: hidden; }
  #frame .snapgrid.layout { margin-top: -10px; }
  #frame .react-grid-item { width: ${input.width}px !important; transform: none !important; inset: 0 !important; }
  *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
`;
document.head.append(style);
// Canvas text uses a font only once it is loaded, and nothing in the DOM asks for every weight.
await Promise.all(['400', '500', '600', '700'].map((weight) => document.fonts.load(`${weight} 12px Inter`)));
createRoot(document.getElementById('root')!).render(<App />);
