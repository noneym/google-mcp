import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export function text(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

export function formatError(e: any): string {
  const apiErr = e?.response?.data?.error;
  if (apiErr) {
    const status = apiErr.status || e.response.status;
    const hint =
      e.response.status === 403 && /scope/i.test(apiErr.message || '')
        ? '\nHint: the stored token lacks a required scope — run google_login again.'
        : '';
    return `Google API error (${status}): ${apiErr.message}${hint}`;
  }
  return e?.message || String(e);
}

/** Registers a tool whose handler returns plain data; errors become isError results. */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title?: string; description: string; annotations?: ToolAnnotations },
  shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) {
  server.registerTool(name, { ...config, inputSchema: shape }, (async (args: any) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return { ...text(formatError(e)), isError: true };
    }
  }) as any);
}

const digits = (v: string) => v.match(/(\d+)\s*$/)?.[1] ?? v;

/** "123", "properties/123" → "properties/123" */
export const propertyName = (v: string) => `properties/${digits(String(v))}`;
/** "123", "accounts/123" → "accounts/123" */
export const accountName = (v: string) => `accounts/${digits(String(v))}`;
/** Accepts a full stream resource name or (property, streamId). */
export function streamName(property: string, stream: string) {
  return stream.includes('/dataStreams/') ? stream : `${propertyName(property)}/dataStreams/${digits(stream)}`;
}

/** Follows nextPageToken until exhausted. */
export async function listAll<T>(
  call: (pageToken?: string) => Promise<{ data: { nextPageToken?: string | null } & Record<string, any> }>,
  key: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await call(pageToken);
    out.push(...((data[key] as T[]) ?? []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return out;
}

/** Calls a method on a googleapis client by dotted path, e.g. "properties.dataStreams.list". */
export async function callByPath(client: any, method: string, params: Record<string, unknown>) {
  const parts = method.split('.');
  let target = client;
  for (const p of parts.slice(0, -1)) {
    target = target?.[p];
    if (!target) throw new Error(`Unknown resource "${p}" in "${method}"`);
  }
  const fn = target[parts.at(-1)!];
  if (typeof fn !== 'function') throw new Error(`Unknown method "${method}"`);
  const { data } = await fn.call(target, params);
  return data;
}

export const gtagSnippet = (measurementId: string) => `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${measurementId}');
</script>`;

const DAY = 86_400_000;

/** "today", "yesterday", "NdaysAgo" or YYYY-MM-DD → Date at UTC midnight (null if unparseable). */
export function resolveDate(s: string): Date | null {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  if (s === 'today') return now;
  if (s === 'yesterday') return new Date(now.getTime() - DAY);
  const rel = s.match(/^(\d+)daysAgo$/);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * DAY);
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Same as resolveDate but returns YYYY-MM-DD and throws on bad input (for APIs without relative dates). */
export function absoluteDate(s: string) {
  const d = resolveDate(s);
  if (!d) throw new Error(`Invalid date "${s}" (use YYYY-MM-DD, today, yesterday or NdaysAgo)`);
  return isoDate(d);
}

/** The equally long range right before [start, end]. */
export function previousRange(start: string, end: string) {
  const s = resolveDate(start);
  const e = resolveDate(end);
  if (!s || !e) return null;
  const len = e.getTime() - s.getTime() + DAY;
  return { startDate: isoDate(new Date(s.getTime() - len)), endDate: isoDate(new Date(s.getTime() - DAY)) };
}
