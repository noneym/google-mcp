import { searchconsole } from '@googleapis/searchconsole';
import { siteVerification } from '@googleapis/siteverification';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAuthClient } from '../auth.js';
import { absoluteDate, callByPath, defineTool, previousRange } from '../util.js';

const gsc = async () => searchconsole({ version: 'v1', auth: await getAuthClient() });
const verifier = async () => siteVerification({ version: 'v1', auth: await getAuthClient() });

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const site = z
  .string()
  .describe(
    'Search Console property: "example.com" or "sc-domain:example.com" (domain property), or "https://example.com/" (URL-prefix property)',
  );
const startDate = z.string().default('28daysAgo').describe('YYYY-MM-DD or "today", "yesterday", "NdaysAgo"');
// Search Console data lags ~2 days, so "yesterday" is the freshest useful end.
const endDate = z.string().default('yesterday').describe('YYYY-MM-DD or "today", "yesterday", "NdaysAgo"');

/** Bare domains become domain properties; URLs get a trailing slash. */
export function siteUrl(v: string) {
  v = v.trim();
  if (v.startsWith('sc-domain:')) return v;
  if (/^https?:\/\//.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return `sc-domain:${v.replace(/\/+$/, '')}`;
}

/** Site Verification API identifies domain and URL-prefix properties differently. */
function verificationSite(v: string) {
  const url = siteUrl(v);
  return url.startsWith('sc-domain:')
    ? { type: 'INET_DOMAIN', identifier: url.slice('sc-domain:'.length) }
    : { type: 'SITE', identifier: url };
}

const DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'] as const;

function formatRows(dimensions: string[], rows: any[] = []) {
  return rows.map((r) => {
    const o: Record<string, string | number> = {};
    dimensions.forEach((d, i) => (o[d] = r.keys?.[i] ?? ''));
    o.clicks = r.clicks ?? 0;
    o.impressions = r.impressions ?? 0;
    o.ctr = Math.round((r.ctr ?? 0) * 10000) / 100; // percent
    o.position = Math.round((r.position ?? 0) * 10) / 10;
    return o;
  });
}

async function query(siteArg: string, body: Record<string, unknown>) {
  const { data } = await (await gsc()).searchanalytics.query({ siteUrl: siteUrl(siteArg), requestBody: body });
  return data.rows ?? [];
}

export function registerSearchConsoleTools(server: McpServer) {
  // ── Sites ───────────────────────────────────────────────────────────────
  defineTool(
    server,
    'gsc_list_sites',
    {
      title: 'List Search Console sites',
      description: 'Lists every Search Console property the user can access, with permission level.',
      annotations: READ,
    },
    {},
    async () => (await (await gsc()).sites.list()).data.siteEntry ?? [],
  );

  defineTool(
    server,
    'gsc_get_verification_token',
    {
      title: 'Get site verification token',
      description:
        'Step 1 of adding a new site: returns what to place so Google can verify ownership. Domain properties ("example.com") need method DNS_TXT (a TXT record on the root domain). URL-prefix properties ("https://example.com/") can also use META (a <meta> tag in <head>), FILE (an html file at the site root), ANALYTICS (the site already has this account\'s GA tag) or TAG_MANAGER. After placing it, call gsc_verify_and_add_site.',
      annotations: READ,
    },
    {
      site,
      method: z.enum(['DNS_TXT', 'DNS_CNAME', 'META', 'FILE', 'ANALYTICS', 'TAG_MANAGER']).default('DNS_TXT'),
    },
    async ({ site, method }) => {
      const target = verificationSite(site);
      if (target.type === 'INET_DOMAIN' && !method.startsWith('DNS')) {
        throw new Error('Domain properties can only be verified with DNS_TXT or DNS_CNAME. Use a URL ("https://…/") for other methods.');
      }
      if (method === 'ANALYTICS' || method === 'TAG_MANAGER') {
        return {
          site: siteUrl(site),
          method,
          instructions: `No token needed: the homepage must already load the ${method === 'ANALYTICS' ? 'Google Analytics (gtag.js)' : 'Google Tag Manager'} snippet of an account you have edit access to. Then call gsc_verify_and_add_site with method ${method}.`,
        };
      }
      const { data } = await (await verifier()).webResource.getToken({
        requestBody: { site: target, verificationMethod: method },
      });
      const token = data.token!;
      const instructions = {
        DNS_TXT: `Add a TXT record on ${target.identifier} with value: ${token}`,
        DNS_CNAME: `Add this CNAME record: ${token}`,
        META: `Put this tag inside <head> of the homepage: ${token}`,
        FILE: `Serve a file at ${target.identifier}${token} whose content is: google-site-verification: ${token}`,
      }[method];
      return { site: siteUrl(site), method, token, instructions, next: 'Once it is live, call gsc_verify_and_add_site.' };
    },
  );

  defineTool(
    server,
    'gsc_verify_and_add_site',
    {
      title: 'Verify and add site',
      description:
        'Step 2 of adding a new site: asks Google to check the verification placed after gsc_get_verification_token, then adds the site to Search Console. DNS changes can take a few minutes to propagate; retry if verification fails.',
      annotations: WRITE,
    },
    {
      site,
      method: z.enum(['DNS_TXT', 'DNS_CNAME', 'META', 'FILE', 'ANALYTICS', 'TAG_MANAGER']).default('DNS_TXT'),
    },
    async ({ site, method }) => {
      const { data: verified } = await (await verifier()).webResource.insert({
        verificationMethod: method,
        requestBody: { site: verificationSite(site) },
      });
      await (await gsc()).sites.add({ siteUrl: siteUrl(site) });
      return { added: siteUrl(site), verified: verified.site, owners: verified.owners };
    },
  );

  defineTool(
    server,
    'gsc_add_site',
    {
      description:
        'Adds a site to Search Console without verifying (useful when ownership is already verified for this Google account, e.g. by another user or an earlier verification).',
      annotations: WRITE,
    },
    { site },
    async ({ site }) => {
      await (await gsc()).sites.add({ siteUrl: siteUrl(site) });
      return (await (await gsc()).sites.get({ siteUrl: siteUrl(site) })).data;
    },
  );

  defineTool(
    server,
    'gsc_remove_site',
    {
      description:
        'Removes a site from this user\'s Search Console list (data is kept by Google; re-adding restores it). Only call after the user explicitly confirmed.',
      annotations: DESTRUCTIVE,
    },
    { site },
    async ({ site }) => {
      await (await gsc()).sites.delete({ siteUrl: siteUrl(site) });
      return { removed: siteUrl(site) };
    },
  );

  // ── Search performance ──────────────────────────────────────────────────
  defineTool(
    server,
    'gsc_performance',
    {
      title: 'Search performance overview',
      description:
        'Google Search clicks, impressions, CTR (%) and average position for a site, with top queries and top pages. Optionally compared to the previous period of equal length. Data lags about 2 days.',
      annotations: READ,
    },
    {
      site,
      startDate,
      endDate,
      top: z.number().int().min(0).max(100).default(10).describe('How many top queries/pages to include'),
      comparePrevious: z.boolean().default(false),
    },
    async ({ site, startDate, endDate, top, comparePrevious }) => {
      const range = { startDate: absoluteDate(startDate), endDate: absoluteDate(endDate) };
      const prev = comparePrevious ? previousRange(range.startDate, range.endDate) : null;
      const [totals, prevTotals, queries, pages] = await Promise.all([
        query(site, { ...range }),
        prev ? query(site, { ...prev }) : Promise.resolve(null),
        top ? query(site, { ...range, dimensions: ['query'], rowLimit: top }) : Promise.resolve([]),
        top ? query(site, { ...range, dimensions: ['page'], rowLimit: top }) : Promise.resolve([]),
      ]);
      return {
        site: siteUrl(site),
        range,
        totals: formatRows([], totals)[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 },
        ...(prev ? { previous: { range: prev, totals: formatRows([], prevTotals ?? [])[0] ?? null } } : {}),
        topQueries: formatRows(['query'], queries),
        topPages: formatRows(['page'], pages),
      };
    },
  );

  defineTool(
    server,
    'gsc_search_analytics',
    {
      title: 'Search analytics query',
      description:
        'Custom Search Console performance report. Group by any of query, page, country (ISO-3166 alpha-3, e.g. "tur"), device (DESKTOP/MOBILE/TABLET), date, searchAppearance. Filters narrow rows, e.g. [{"dimension":"query","operator":"contains","expression":"film"}].',
      annotations: READ,
    },
    {
      site,
      startDate,
      endDate,
      dimensions: z.array(z.enum(DIMENSIONS)).default(['query']),
      filters: z
        .array(
          z.object({
            dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
            operator: z
              .enum(['contains', 'equals', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex'])
              .default('contains'),
            expression: z.string(),
          }),
        )
        .default([]),
      type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      orderBy: z.enum(['clicks', 'impressions', 'ctr', 'position']).optional().describe('Sorted client-side; Google returns by clicks'),
      rowLimit: z.number().int().min(1).max(25000).default(100),
      startRow: z.number().int().min(0).default(0),
      fresh: z.boolean().default(false).describe('Include not-yet-final data from the last ~2 days'),
    },
    async (a) => {
      const rows = await query(a.site, {
        startDate: absoluteDate(a.startDate),
        endDate: absoluteDate(a.endDate),
        dimensions: a.dimensions,
        type: a.type,
        rowLimit: a.rowLimit,
        startRow: a.startRow,
        dataState: a.fresh ? 'all' : 'final',
        ...(a.filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: a.filters }] } : {}),
      });
      const out = formatRows(a.dimensions, rows);
      if (a.orderBy) {
        const k = a.orderBy;
        out.sort((x, y) => (k === 'position' ? +x[k] - +y[k] : +y[k] - +x[k]));
      }
      return { rowCount: out.length, rows: out };
    },
  );

  // ── Sitemaps ────────────────────────────────────────────────────────────
  defineTool(
    server,
    'gsc_list_sitemaps',
    { description: 'Lists sitemaps submitted for a site, with status, errors and indexed counts.', annotations: READ },
    { site },
    async ({ site }) => (await (await gsc()).sitemaps.list({ siteUrl: siteUrl(site) })).data.sitemap ?? [],
  );

  defineTool(
    server,
    'gsc_submit_sitemap',
    { description: 'Submits (or resubmits) a sitemap URL for a site.', annotations: WRITE },
    { site, sitemapUrl: z.string().describe('Full URL, e.g. https://example.com/sitemap.xml') },
    async ({ site, sitemapUrl }) => {
      await (await gsc()).sitemaps.submit({ siteUrl: siteUrl(site), feedpath: sitemapUrl });
      return { submitted: sitemapUrl, site: siteUrl(site) };
    },
  );

  defineTool(
    server,
    'gsc_delete_sitemap',
    { description: 'Removes a submitted sitemap from Search Console.', annotations: DESTRUCTIVE },
    { site, sitemapUrl: z.string() },
    async ({ site, sitemapUrl }) => {
      await (await gsc()).sitemaps.delete({ siteUrl: siteUrl(site), feedpath: sitemapUrl });
      return { deleted: sitemapUrl };
    },
  );

  // ── URL inspection ──────────────────────────────────────────────────────
  defineTool(
    server,
    'gsc_inspect_url',
    {
      title: 'Inspect URL index status',
      description:
        'Shows whether Google has indexed a URL: coverage state, last crawl time, canonical, robots/indexing blocks, mobile usability and rich results. The URL must belong to the given site. (The API cannot request indexing; that stays in the Search Console UI.)',
      annotations: READ,
    },
    { site, url: z.string(), languageCode: z.string().default('tr-TR') },
    async ({ site, url, languageCode }) => {
      const { data } = await (await gsc()).urlInspection.index.inspect({
        requestBody: { siteUrl: siteUrl(site), inspectionUrl: url, languageCode },
      });
      const r = data.inspectionResult ?? {};
      const idx = r.indexStatusResult ?? {};
      return {
        url,
        verdict: idx.verdict,
        coverageState: idx.coverageState,
        indexingState: idx.indexingState,
        robotsTxtState: idx.robotsTxtState,
        pageFetchState: idx.pageFetchState,
        lastCrawlTime: idx.lastCrawlTime,
        crawledAs: idx.crawledAs,
        googleCanonical: idx.googleCanonical,
        userCanonical: idx.userCanonical,
        sitemaps: idx.sitemap,
        referringUrls: idx.referringUrls,
        mobileUsability: r.mobileUsabilityResult?.verdict,
        richResults: r.richResultsResult?.detectedItems?.map((i: any) => i.richResultType),
        inspectionResultLink: r.inspectionResultLink,
      };
    },
  );

  // ── Escape hatch ────────────────────────────────────────────────────────
  defineTool(
    server,
    'gsc_api',
    {
      title: 'Raw Search Console API call',
      description:
        'Calls any Search Console API (v1) or Site Verification API (v1) method directly. api "searchconsole": e.g. "sites.get", "searchanalytics.query", "urlInspection.index.inspect". api "siteverification": e.g. "webResource.list", "webResource.delete". Params are the method params with the body under `requestBody`.',
      annotations: { openWorldHint: true },
    },
    {
      api: z.enum(['searchconsole', 'siteverification']).default('searchconsole'),
      method: z.string(),
      params: z.record(z.string(), z.any()).default({}),
    },
    async ({ api, method, params }) => callByPath(api === 'siteverification' ? await verifier() : await gsc(), method, params),
  );
}
