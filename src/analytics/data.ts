import { analyticsadmin } from '@googleapis/analyticsadmin';
import { analyticsdata } from '@googleapis/analyticsdata';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAuthClient } from '../auth.js';
import { callByPath, defineTool, listAll, propertyName } from '../util.js';

const data = async () => analyticsdata({ version: 'v1beta', auth: await getAuthClient() });

const property = z.string().describe('GA4 property id, e.g. "123456789" or "properties/123456789"');
const startDate = z
  .string()
  .default('28daysAgo')
  .describe('YYYY-MM-DD or relative: "today", "yesterday", "7daysAgo", "28daysAgo"');
const endDate = z.string().default('today').describe('YYYY-MM-DD or relative ("today", "yesterday")');
const READ = { readOnlyHint: true, openWorldHint: true };

const NUMERIC = /^TYPE_(INTEGER|FLOAT|SECONDS|MILLISECONDS|MINUTES|HOURS|STANDARD|CURRENCY|FEET|MILES|METERS|KILOMETERS)$/;

/** Turns the column/row arrays of a GA report into plain row objects. */
function formatReport(r: any) {
  const dims = (r.dimensionHeaders ?? []).map((h: any) => h.name);
  const mets = (r.metricHeaders ?? []).map((h: any) => ({ name: h.name, numeric: NUMERIC.test(h.type ?? '') }));
  const toRow = (row: any) => {
    const o: Record<string, string | number> = {};
    dims.forEach((d: string, i: number) => (o[d] = row.dimensionValues?.[i]?.value ?? ''));
    mets.forEach((m: { name: string; numeric: boolean }, i: number) => {
      const v = row.metricValues?.[i]?.value ?? '';
      o[m.name] = m.numeric && v !== '' ? Number(v) : v;
    });
    return o;
  };
  return {
    rowCount: r.rowCount ?? 0,
    rows: (r.rows ?? []).map(toRow),
    ...(r.totals?.length ? { totals: toRow(r.totals[0]) } : {}),
    ...(r.metadata?.currencyCode || r.metadata?.timeZone
      ? { currencyCode: r.metadata.currencyCode, timeZone: r.metadata.timeZone }
      : {}),
  };
}

const PRESETS: Record<string, { dimensions: string[]; metrics: string[]; orderBy?: string; desc?: boolean }> = {
  overview: {
    dimensions: [],
    metrics: ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration', 'bounceRate', 'eventCount'],
  },
  daily: { dimensions: ['date'], metrics: ['activeUsers', 'newUsers', 'sessions', 'screenPageViews'], orderBy: 'date', desc: false },
  top_pages: { dimensions: ['pagePath'], metrics: ['screenPageViews', 'activeUsers', 'userEngagementDuration'], orderBy: 'screenPageViews' },
  page_titles: { dimensions: ['pageTitle'], metrics: ['screenPageViews', 'activeUsers'], orderBy: 'screenPageViews' },
  landing_pages: { dimensions: ['landingPage'], metrics: ['sessions', 'activeUsers', 'engagementRate'], orderBy: 'sessions' },
  sources: { dimensions: ['sessionSourceMedium'], metrics: ['sessions', 'activeUsers', 'engagementRate'], orderBy: 'sessions' },
  channels: { dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions', 'activeUsers', 'engagementRate'], orderBy: 'sessions' },
  countries: { dimensions: ['country'], metrics: ['activeUsers', 'sessions'], orderBy: 'activeUsers' },
  cities: { dimensions: ['city'], metrics: ['activeUsers', 'sessions'], orderBy: 'activeUsers' },
  devices: { dimensions: ['deviceCategory'], metrics: ['activeUsers', 'sessions'], orderBy: 'activeUsers' },
  browsers: { dimensions: ['browser'], metrics: ['activeUsers', 'sessions'], orderBy: 'activeUsers' },
  os: { dimensions: ['operatingSystem'], metrics: ['activeUsers', 'sessions'], orderBy: 'activeUsers' },
  languages: { dimensions: ['language'], metrics: ['activeUsers'], orderBy: 'activeUsers' },
  events: { dimensions: ['eventName'], metrics: ['eventCount', 'totalUsers'], orderBy: 'eventCount' },
  key_events: { dimensions: ['eventName'], metrics: ['keyEvents', 'totalUsers'], orderBy: 'keyEvents' },
};

const REALTIME_PRESETS: Record<string, string[]> = {
  total: [],
  pages: ['unifiedScreenName'],
  countries: ['country'],
  cities: ['city'],
  devices: ['deviceCategory'],
  sources: ['firstUserSource'],
  events: ['eventName'],
};

const orderBy = (name: string, metrics: string[], desc = true) =>
  metrics.includes(name) ? { metric: { metricName: name }, desc } : { dimension: { dimensionName: name }, desc };

export function registerDataTools(server: McpServer) {
  defineTool(
    server,
    'ga_get_visitors',
    {
      title: 'Visitor counts',
      description:
        'Visitor numbers for a property over a date range: active users, new users, sessions, page views, engagement. Optionally a per-day breakdown and comparison with the previous period of equal length.',
      annotations: READ,
    },
    {
      property,
      startDate,
      endDate,
      daily: z.boolean().default(false).describe('Also return a per-day breakdown'),
      comparePrevious: z.boolean().default(false).describe('Also return the preceding period of the same length'),
    },
    async ({ property, startDate, endDate, daily, comparePrevious }) => {
      const api = await data();
      const metrics = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagementRate', 'averageSessionDuration'].map(
        (name) => ({ name }),
      );
      const dateRanges: any[] = [{ startDate, endDate, name: 'current' }];
      if (comparePrevious) {
        const prev = previousRange(startDate, endDate);
        if (prev) dateRanges.push({ ...prev, name: 'previous' });
      }
      const requests: any[] = [{ dateRanges, metrics, dimensions: dateRanges.length > 1 ? [{ name: 'dateRange' }] : [] }];
      if (daily) {
        requests.push({
          dateRanges: [{ startDate, endDate }],
          metrics: metrics.slice(0, 4),
          dimensions: [{ name: 'date' }],
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: '400',
        });
      }
      const { data: res } = await api.properties.batchRunReports({
        property: propertyName(property),
        requestBody: { requests },
      });
      const [summary, perDay] = (res.reports ?? []).map(formatReport);
      return {
        property: propertyName(property),
        range: { startDate, endDate },
        summary: summary.rows.length > 1 ? summary.rows : summary.rows[0] ?? {},
        ...(perDay ? { daily: perDay.rows } : {}),
      };
    },
  );

  defineTool(
    server,
    'ga_realtime',
    {
      title: 'Realtime visitors',
      description:
        'Active users in the last 30 minutes (or a shorter window), optionally broken down by page, country, city, device, source or event.',
      annotations: READ,
    },
    {
      property,
      breakdown: z.enum(Object.keys(REALTIME_PRESETS) as [string, ...string[]]).default('total'),
      minutesAgo: z.number().int().min(1).max(29).default(29).describe('Window start, in minutes ago (max 29; 59 on GA360)'),
      limit: z.number().int().min(1).max(1000).default(20),
    },
    async ({ property, breakdown, minutesAgo, limit }) => {
      const dims = REALTIME_PRESETS[breakdown];
      const metrics = breakdown === 'events' ? ['eventCount', 'activeUsers'] : ['activeUsers'];
      const { data: r } = await (await data()).properties.runRealtimeReport({
        property: propertyName(property),
        requestBody: {
          dimensions: dims.map((name) => ({ name })),
          metrics: metrics.map((name) => ({ name })),
          minuteRanges: [{ startMinutesAgo: minutesAgo, endMinutesAgo: 0 }],
          orderBys: dims.length ? [{ metric: { metricName: metrics[0] }, desc: true }] : undefined,
          limit: String(limit),
          metricAggregations: dims.length ? ['TOTAL'] : undefined,
        },
      });
      return formatReport(r);
    },
  );

  defineTool(
    server,
    'ga_quick_report',
    {
      title: 'Preset report',
      description: `Ready-made report. Presets: ${Object.keys(PRESETS).join(', ')}.`,
      annotations: READ,
    },
    {
      property,
      preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]),
      startDate,
      endDate,
      limit: z.number().int().min(1).max(10000).default(25),
    },
    async ({ property, preset, startDate, endDate, limit }) => {
      const p = PRESETS[preset];
      const { data: r } = await (await data()).properties.runReport({
        property: propertyName(property),
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: p.dimensions.map((name) => ({ name })),
          metrics: p.metrics.map((name) => ({ name })),
          orderBys: p.orderBy ? [orderBy(p.orderBy, p.metrics, p.desc ?? true)] : undefined,
          limit: String(limit),
          metricAggregations: p.dimensions.length ? ['TOTAL'] : undefined,
        },
      });
      return { preset, range: { startDate, endDate }, ...formatReport(r) };
    },
  );

  defineTool(
    server,
    'ga_run_report',
    {
      title: 'Custom report',
      description:
        'Runs a custom GA4 Data API report. Use ga_get_metadata for valid dimension/metric names. Filters use the Data API FilterExpression JSON, e.g. {"filter":{"fieldName":"country","stringFilter":{"value":"Turkey"}}}.',
      annotations: READ,
    },
    {
      property,
      dimensions: z.array(z.string()).default([]),
      metrics: z.array(z.string()).min(1),
      startDate,
      endDate,
      dateRanges: z
        .array(z.object({ startDate: z.string(), endDate: z.string(), name: z.string().optional() }))
        .optional()
        .describe('Multiple ranges (overrides startDate/endDate)'),
      dimensionFilter: z.any().optional(),
      metricFilter: z.any().optional(),
      orderBy: z.string().optional().describe('Dimension or metric name to sort by'),
      desc: z.boolean().default(true),
      limit: z.number().int().min(1).max(250000).default(100),
      offset: z.number().int().min(0).default(0),
      totals: z.boolean().default(false),
    },
    async (a) => {
      const { data: r } = await (await data()).properties.runReport({
        property: propertyName(a.property),
        requestBody: {
          dateRanges: a.dateRanges ?? [{ startDate: a.startDate, endDate: a.endDate }],
          dimensions: a.dimensions.map((name) => ({ name })),
          metrics: a.metrics.map((name) => ({ name })),
          dimensionFilter: a.dimensionFilter,
          metricFilter: a.metricFilter,
          orderBys: a.orderBy ? [orderBy(a.orderBy, a.metrics, a.desc)] : undefined,
          limit: String(a.limit),
          offset: String(a.offset),
          metricAggregations: a.totals ? ['TOTAL'] : undefined,
        },
      });
      return formatReport(r);
    },
  );

  defineTool(
    server,
    'ga_run_realtime_report',
    { description: 'Runs a custom realtime report (last 30 minutes).', annotations: READ },
    {
      property,
      dimensions: z.array(z.string()).default([]),
      metrics: z.array(z.string()).default(['activeUsers']),
      dimensionFilter: z.any().optional(),
      limit: z.number().int().min(1).max(10000).default(50),
    },
    async ({ property, dimensions, metrics, dimensionFilter, limit }) =>
      formatReport(
        (
          await (await data()).properties.runRealtimeReport({
            property: propertyName(property),
            requestBody: {
              dimensions: dimensions.map((name) => ({ name })),
              metrics: metrics.map((name) => ({ name })),
              dimensionFilter,
              limit: String(limit),
            },
          })
        ).data,
      ),
  );

  defineTool(
    server,
    'ga_get_metadata',
    {
      description: 'Lists dimension and metric names available for a property (including custom ones). Optional text filter.',
      annotations: READ,
    },
    { property, search: z.string().optional().describe('Case-insensitive filter on api name / ui name') },
    async ({ property, search }) => {
      const { data: m } = await (await data()).properties.getMetadata({ name: `${propertyName(property)}/metadata` });
      const q = search?.toLowerCase();
      const pick = (xs: any[] = []) =>
        xs
          .filter((x) => !q || `${x.apiName} ${x.uiName}`.toLowerCase().includes(q))
          .map((x) => ({ apiName: x.apiName, uiName: x.uiName, category: x.category, ...(x.type ? { type: x.type } : {}) }));
      return { dimensions: pick(m.dimensions), metrics: pick(m.metrics) };
    },
  );

  defineTool(
    server,
    'ga_visitors_all_properties',
    {
      title: 'Visitors across all sites',
      description: 'Active users, sessions and page views for every GA4 property the user can access, sorted by active users.',
      annotations: READ,
    },
    { startDate: startDate.default('7daysAgo'), endDate },
    async ({ startDate, endDate }) => {
      const admin = analyticsadmin({ version: 'v1beta', auth: await getAuthClient() });
      const summaries = await listAll<any>(
        (pageToken) => admin.accountSummaries.list({ pageSize: 200, pageToken }),
        'accountSummaries',
      );
      const props = summaries.flatMap((a) =>
        (a.propertySummaries ?? []).map((p: any) => ({ account: a.displayName, property: p.property, name: p.displayName })),
      );
      const api = await data();
      const results: any[] = [];
      const queue = [...props];
      await Promise.all(
        Array.from({ length: Math.min(5, queue.length) }, async () => {
          for (let p = queue.shift(); p; p = queue.shift()) {
            try {
              const { data: r } = await api.properties.runReport({
                property: p.property,
                requestBody: {
                  dateRanges: [{ startDate, endDate }],
                  metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
                },
              });
              results.push({ ...p, ...(formatReport(r).rows[0] ?? { activeUsers: 0, sessions: 0, screenPageViews: 0 }) });
            } catch (e: any) {
              results.push({ ...p, error: e?.response?.data?.error?.message || e.message });
            }
          }
        }),
      );
      results.sort((x, y) => (y.activeUsers ?? -1) - (x.activeUsers ?? -1));
      return { range: { startDate, endDate }, properties: results };
    },
  );

  defineTool(
    server,
    'ga_data_api',
    {
      title: 'Raw GA Data API call',
      description:
        'Calls any GA4 Data API (v1beta) method directly, e.g. "properties.batchRunReports", "properties.runPivotReport", "properties.checkCompatibility". Params include `property` and `requestBody`. Returns the raw response.',
      annotations: READ,
    },
    { method: z.string(), params: z.record(z.string(), z.any()).default({}) },
    async ({ method, params }) => callByPath(await data(), method, params),
  );
}

/** For absolute YYYY-MM-DD ranges, the equally long range right before it. */
function previousRange(start: string, end: string) {
  const resolve = (s: string) => {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    if (s === 'today') return now;
    if (s === 'yesterday') return new Date(now.getTime() - 86_400_000);
    const rel = s.match(/^(\d+)daysAgo$/);
    if (rel) return new Date(now.getTime() - Number(rel[1]) * 86_400_000);
    const d = new Date(`${s}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  };
  const s = resolve(start);
  const e = resolve(end);
  if (!s || !e) return null;
  const len = e.getTime() - s.getTime() + 86_400_000;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(new Date(s.getTime() - len)), endDate: fmt(new Date(s.getTime() - 86_400_000)) };
}
