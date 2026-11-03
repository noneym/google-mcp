import { analyticsadmin } from '@googleapis/analyticsadmin';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAuthClient } from '../auth.js';
import {
  accountName,
  callByPath,
  defineTool,
  gtagSnippet,
  listAll,
  propertyName,
  streamName,
} from '../util.js';

const beta = async () => analyticsadmin({ version: 'v1beta', auth: await getAuthClient() });
const alpha = async () => analyticsadmin({ version: 'v1alpha', auth: await getAuthClient() });

const property = z.string().describe('GA4 property id, e.g. "123456789" or "properties/123456789"');
const account = z.string().describe('GA account id, e.g. "123456" or "accounts/123456"');
const stream = z.string().describe('Data stream id, e.g. "987654" or a full "properties/x/dataStreams/y" name');

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const TOS_URL = (ticket: string) =>
  `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${ticket}`;

function withSnippet(s: any) {
  const id = s?.webStreamData?.measurementId;
  return id ? { ...s, measurementId: id, gtagSnippet: gtagSnippet(id) } : s;
}

export function registerAdminTools(server: McpServer) {
  // ── Accounts ────────────────────────────────────────────────────────────
  defineTool(
    server,
    'ga_list_account_summaries',
    {
      title: 'List GA accounts and properties',
      description:
        'Lists every Google Analytics account the user can access, with the GA4 properties under each. Start here to find property ids.',
      annotations: READ,
    },
    {},
    async () => {
      const admin = await beta();
      const summaries = await listAll<any>(
        (pageToken) => admin.accountSummaries.list({ pageSize: 200, pageToken }),
        'accountSummaries',
      );
      return summaries.map((a) => ({
        account: a.account,
        displayName: a.displayName,
        properties: (a.propertySummaries ?? []).map((p: any) => ({
          property: p.property,
          displayName: p.displayName,
          propertyType: p.propertyType,
          parent: p.parent,
        })),
      }));
    },
  );

  defineTool(
    server,
    'ga_get_account',
    { description: 'Gets a Google Analytics account.', annotations: READ },
    { account },
    async ({ account }) => (await (await beta()).accounts.get({ name: accountName(account) })).data,
  );

  defineTool(
    server,
    'ga_create_account',
    {
      title: 'Create GA account',
      description:
        'Starts creation of a new Google Analytics account. Google requires the user to accept the Terms of Service in a browser: this returns a termsOfServiceUrl the user must open while signed in with the same Google account. After acceptance the account appears in ga_list_account_summaries.',
      annotations: WRITE,
    },
    {
      displayName: z.string().describe('Account name'),
      regionCode: z.string().default('TR').describe('CLDR region code of the business, e.g. "TR", "US"'),
      redirectUri: z
        .string()
        .optional()
        .describe(
          'Where Google sends the user after accepting the ToS. Must be an authorized redirect URI of the OAuth client. Defaults to GA_PROVISION_REDIRECT_URI env or https://analytics.google.com/analytics/web/.',
        ),
    },
    async ({ displayName, regionCode, redirectUri }) => {
      const { data } = await (await beta()).accounts.provisionAccountTicket({
        requestBody: {
          account: { displayName, regionCode },
          redirectUri: redirectUri || process.env.GA_PROVISION_REDIRECT_URI || 'https://analytics.google.com/analytics/web/',
        },
      });
      return {
        accountTicketId: data.accountTicketId,
        termsOfServiceUrl: TOS_URL(data.accountTicketId!),
        next: 'Open termsOfServiceUrl in a browser and accept the terms; the account is created on acceptance.',
      };
    },
  );

  defineTool(
    server,
    'ga_update_account',
    { description: 'Renames a Google Analytics account.', annotations: WRITE },
    { account, displayName: z.string() },
    async ({ account, displayName }) =>
      (
        await (await beta()).accounts.patch({
          name: accountName(account),
          updateMask: 'displayName',
          requestBody: { displayName },
        })
      ).data,
  );

  defineTool(
    server,
    'ga_delete_account',
    {
      description:
        'Moves a Google Analytics account (and all its properties) to trash. Recoverable in the GA UI for 35 days. Only call after the user explicitly confirmed.',
      annotations: DESTRUCTIVE,
    },
    { account },
    async ({ account }) => {
      await (await beta()).accounts.delete({ name: accountName(account) });
      return { deleted: accountName(account) };
    },
  );

  // ── Properties ──────────────────────────────────────────────────────────
  defineTool(
    server,
    'ga_list_properties',
    { description: 'Lists GA4 properties under an account.', annotations: READ },
    { account, showDeleted: z.boolean().default(false) },
    async ({ account, showDeleted }) => {
      const admin = await beta();
      return listAll(
        (pageToken) =>
          admin.properties.list({ filter: `parent:${accountName(account)}`, showDeleted, pageSize: 200, pageToken }),
        'properties',
      );
    },
  );

  defineTool(
    server,
    'ga_get_property',
    { description: 'Gets a GA4 property (time zone, currency, industry, …).', annotations: READ },
    { property },
    async ({ property }) => (await (await beta()).properties.get({ name: propertyName(property) })).data,
  );

  const propertyFields = {
    timeZone: z.string().optional().describe('IANA time zone, e.g. "Europe/Istanbul"'),
    currencyCode: z.string().optional().describe('ISO 4217 code, e.g. "TRY", "USD"'),
    industryCategory: z
      .string()
      .optional()
      .describe('e.g. TECHNOLOGY, SHOPPING, ONLINE_COMMUNITIES, ARTS_AND_ENTERTAINMENT, BUSINESS_AND_INDUSTRIAL_MARKETS'),
  };

  defineTool(
    server,
    'ga_create_property',
    { description: 'Creates a new GA4 property under an account.', annotations: WRITE },
    {
      account,
      displayName: z.string(),
      ...propertyFields,
      timeZone: propertyFields.timeZone.default('Europe/Istanbul'),
      currencyCode: propertyFields.currencyCode.default('TRY'),
    },
    async ({ account, displayName, timeZone, currencyCode, industryCategory }) =>
      (
        await (await beta()).properties.create({
          requestBody: {
            parent: accountName(account),
            displayName,
            timeZone,
            currencyCode,
            industryCategory,
            propertyType: 'PROPERTY_TYPE_ORDINARY',
          },
        })
      ).data,
  );

  defineTool(
    server,
    'ga_update_property',
    { description: 'Updates display name, time zone, currency or industry of a GA4 property.', annotations: WRITE },
    { property, displayName: z.string().optional(), ...propertyFields },
    async ({ property, ...fields }) => {
      const requestBody = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (!Object.keys(requestBody).length) throw new Error('Nothing to update.');
      return (
        await (await beta()).properties.patch({
          name: propertyName(property),
          updateMask: Object.keys(requestBody).join(','),
          requestBody,
        })
      ).data;
    },
  );

  defineTool(
    server,
    'ga_delete_property',
    {
      description:
        'Moves a GA4 property to trash (recoverable for 35 days in the GA UI). Only call after the user explicitly confirmed.',
      annotations: DESTRUCTIVE,
    },
    { property },
    async ({ property }) => (await (await beta()).properties.delete({ name: propertyName(property) })).data,
  );

  defineTool(
    server,
    'ga_setup_website',
    {
      title: 'One-step website setup',
      description:
        'Creates a GA4 property plus a web data stream for a website and returns the G- measurement id and the gtag.js snippet to paste into <head>.',
      annotations: WRITE,
    },
    {
      account,
      url: z.string().describe('Website URL, e.g. "https://example.com"'),
      displayName: z.string().optional().describe('Property name (defaults to the hostname)'),
      ...propertyFields,
      timeZone: propertyFields.timeZone.default('Europe/Istanbul'),
      currencyCode: propertyFields.currencyCode.default('TRY'),
    },
    async ({ account, url, displayName, timeZone, currencyCode, industryCategory }) => {
      const admin = await beta();
      const defaultUri = /^https?:\/\//.test(url) ? url : `https://${url}`;
      const name = displayName || new URL(defaultUri).hostname;
      const { data: prop } = await admin.properties.create({
        requestBody: {
          parent: accountName(account),
          displayName: name,
          timeZone,
          currencyCode,
          industryCategory,
          propertyType: 'PROPERTY_TYPE_ORDINARY',
        },
      });
      const { data: s } = await admin.properties.dataStreams.create({
        parent: prop.name!,
        requestBody: { type: 'WEB_DATA_STREAM', displayName: name, webStreamData: { defaultUri } },
      });
      return {
        property: prop.name,
        propertyDisplayName: prop.displayName,
        dataStream: s.name,
        measurementId: s.webStreamData?.measurementId,
        gtagSnippet: gtagSnippet(s.webStreamData!.measurementId!),
      };
    },
  );

  // ── Data streams ────────────────────────────────────────────────────────
  defineTool(
    server,
    'ga_list_data_streams',
    {
      description: 'Lists data streams of a property. Web streams include their G- measurement id and gtag snippet.',
      annotations: READ,
    },
    { property },
    async ({ property }) => {
      const admin = await beta();
      const streams = await listAll<any>(
        (pageToken) => admin.properties.dataStreams.list({ parent: propertyName(property), pageSize: 200, pageToken }),
        'dataStreams',
      );
      return streams.map(withSnippet);
    },
  );

  defineTool(
    server,
    'ga_get_data_stream',
    { description: 'Gets one data stream (with G- measurement id and gtag snippet for web streams).', annotations: READ },
    { property, stream },
    async ({ property, stream }) =>
      withSnippet((await (await beta()).properties.dataStreams.get({ name: streamName(property, stream) })).data),
  );

  defineTool(
    server,
    'ga_create_data_stream',
    {
      description:
        'Creates a data stream on a property. For type WEB the result contains the G- measurement id and gtag snippet.',
      annotations: WRITE,
    },
    {
      property,
      type: z.enum(['WEB', 'ANDROID', 'IOS']).default('WEB'),
      displayName: z.string(),
      url: z.string().optional().describe('Website URL (WEB)'),
      packageName: z.string().optional().describe('Android package name (ANDROID)'),
      bundleId: z.string().optional().describe('iOS bundle id (IOS)'),
    },
    async ({ property, type, displayName, url, packageName, bundleId }) => {
      const requestBody: any = { type: `${type}_${type === 'WEB' ? 'DATA' : 'APP'}_STREAM`, displayName };
      if (type === 'WEB') {
        if (!url) throw new Error('url is required for WEB streams');
        requestBody.webStreamData = { defaultUri: /^https?:\/\//.test(url) ? url : `https://${url}` };
      } else if (type === 'ANDROID') {
        if (!packageName) throw new Error('packageName is required for ANDROID streams');
        requestBody.androidAppStreamData = { packageName };
      } else {
        if (!bundleId) throw new Error('bundleId is required for IOS streams');
        requestBody.iosAppStreamData = { bundleId };
      }
      return withSnippet(
        (await (await beta()).properties.dataStreams.create({ parent: propertyName(property), requestBody })).data,
      );
    },
  );

  defineTool(
    server,
    'ga_update_data_stream',
    { description: 'Renames a data stream.', annotations: WRITE },
    { property, stream, displayName: z.string() },
    async ({ property, stream, displayName }) =>
      (
        await (await beta()).properties.dataStreams.patch({
          name: streamName(property, stream),
          updateMask: 'displayName',
          requestBody: { displayName },
        })
      ).data,
  );

  defineTool(
    server,
    'ga_delete_data_stream',
    {
      description: 'Deletes a data stream (not recoverable). Only call after the user explicitly confirmed.',
      annotations: DESTRUCTIVE,
    },
    { property, stream },
    async ({ property, stream }) => {
      await (await beta()).properties.dataStreams.delete({ name: streamName(property, stream) });
      return { deleted: streamName(property, stream) };
    },
  );

  defineTool(
    server,
    'ga_get_tag_snippet',
    { description: 'Returns the gtag.js snippet for a G- measurement id.', annotations: { readOnlyHint: true } },
    { measurementId: z.string().regex(/^G-[A-Z0-9]+$/i) },
    async ({ measurementId }) => ({ measurementId, gtagSnippet: gtagSnippet(measurementId.toUpperCase()) }),
  );

  // ── Measurement Protocol secrets ────────────────────────────────────────
  defineTool(
    server,
    'ga_list_measurement_protocol_secrets',
    { description: 'Lists Measurement Protocol API secrets of a data stream.', annotations: READ },
    { property, stream },
    async ({ property, stream }) =>
      (
        await (await beta()).properties.dataStreams.measurementProtocolSecrets.list({
          parent: streamName(property, stream),
        })
      ).data.measurementProtocolSecrets ?? [],
  );

  defineTool(
    server,
    'ga_create_measurement_protocol_secret',
    { description: 'Creates a Measurement Protocol API secret for server-side event sending.', annotations: WRITE },
    { property, stream, displayName: z.string() },
    async ({ property, stream, displayName }) =>
      (
        await (await beta()).properties.dataStreams.measurementProtocolSecrets.create({
          parent: streamName(property, stream),
          requestBody: { displayName },
        })
      ).data,
  );

  // ── Key events (conversions) ────────────────────────────────────────────
  defineTool(
    server,
    'ga_list_key_events',
    { description: 'Lists key events (conversions) of a property.', annotations: READ },
    { property },
    async ({ property }) => {
      const admin = await beta();
      return listAll(
        (pageToken) => admin.properties.keyEvents.list({ parent: propertyName(property), pageSize: 200, pageToken }),
        'keyEvents',
      );
    },
  );

  defineTool(
    server,
    'ga_create_key_event',
    { description: 'Marks an event name as a key event (conversion).', annotations: WRITE },
    {
      property,
      eventName: z.string(),
      countingMethod: z.enum(['ONCE_PER_EVENT', 'ONCE_PER_SESSION']).default('ONCE_PER_EVENT'),
    },
    async ({ property, eventName, countingMethod }) =>
      (
        await (await beta()).properties.keyEvents.create({
          parent: propertyName(property),
          requestBody: { eventName, countingMethod },
        })
      ).data,
  );

  defineTool(
    server,
    'ga_delete_key_event',
    { description: 'Removes a key event. `keyEvent` is its resource name or id.', annotations: DESTRUCTIVE },
    { property, keyEvent: z.string() },
    async ({ property, keyEvent }) => {
      const name = keyEvent.includes('/') ? keyEvent : `${propertyName(property)}/keyEvents/${keyEvent}`;
      await (await beta()).properties.keyEvents.delete({ name });
      return { deleted: name };
    },
  );

  // ── Custom dimensions / metrics ─────────────────────────────────────────
  defineTool(
    server,
    'ga_list_custom_definitions',
    { description: 'Lists custom dimensions and custom metrics of a property.', annotations: READ },
    { property },
    async ({ property }) => {
      const admin = await beta();
      const parent = propertyName(property);
      const [customDimensions, customMetrics] = await Promise.all([
        listAll((pageToken) => admin.properties.customDimensions.list({ parent, pageSize: 200, pageToken }), 'customDimensions'),
        listAll((pageToken) => admin.properties.customMetrics.list({ parent, pageSize: 200, pageToken }), 'customMetrics'),
      ]);
      return { customDimensions, customMetrics };
    },
  );

  defineTool(
    server,
    'ga_create_custom_dimension',
    { description: 'Creates a custom dimension from an event/user parameter.', annotations: WRITE },
    {
      property,
      parameterName: z.string(),
      displayName: z.string(),
      scope: z.enum(['EVENT', 'USER', 'ITEM']).default('EVENT'),
      description: z.string().optional(),
    },
    async ({ property, ...requestBody }) =>
      (await (await beta()).properties.customDimensions.create({ parent: propertyName(property), requestBody })).data,
  );

  defineTool(
    server,
    'ga_create_custom_metric',
    { description: 'Creates a custom metric from an event parameter.', annotations: WRITE },
    {
      property,
      parameterName: z.string(),
      displayName: z.string(),
      measurementUnit: z
        .enum(['STANDARD', 'CURRENCY', 'FEET', 'METERS', 'KILOMETERS', 'MILES', 'MILLISECONDS', 'SECONDS', 'MINUTES', 'HOURS'])
        .default('STANDARD'),
      description: z.string().optional(),
    },
    async ({ property, ...rest }) =>
      (
        await (await beta()).properties.customMetrics.create({
          parent: propertyName(property),
          requestBody: { ...rest, scope: 'EVENT' },
        })
      ).data,
  );

  defineTool(
    server,
    'ga_archive_custom_definition',
    {
      description: 'Archives a custom dimension or metric by resource name (properties/x/customDimensions/y or …/customMetrics/y).',
      annotations: DESTRUCTIVE,
    },
    { name: z.string() },
    async ({ name }) => {
      const admin = await beta();
      if (name.includes('/customMetrics/')) await admin.properties.customMetrics.archive({ name, requestBody: {} });
      else await admin.properties.customDimensions.archive({ name, requestBody: {} });
      return { archived: name };
    },
  );

  // ── Data retention ──────────────────────────────────────────────────────
  defineTool(
    server,
    'ga_get_data_retention',
    { description: 'Gets data retention settings of a property.', annotations: READ },
    { property },
    async ({ property }) =>
      (
        await (await beta()).properties.getDataRetentionSettings({
          name: `${propertyName(property)}/dataRetentionSettings`,
        })
      ).data,
  );

  defineTool(
    server,
    'ga_update_data_retention',
    { description: 'Updates event data retention (e.g. FOURTEEN_MONTHS for the free maximum).', annotations: WRITE },
    {
      property,
      eventDataRetention: z.enum(['TWO_MONTHS', 'FOURTEEN_MONTHS', 'TWENTY_SIX_MONTHS', 'THIRTY_EIGHT_MONTHS', 'FIFTY_MONTHS']),
      resetUserDataOnNewActivity: z.boolean().optional(),
    },
    async ({ property, eventDataRetention, resetUserDataOnNewActivity }) => {
      const requestBody: any = { eventDataRetention };
      if (resetUserDataOnNewActivity !== undefined) requestBody.resetUserDataOnNewActivity = resetUserDataOnNewActivity;
      return (
        await (await beta()).properties.updateDataRetentionSettings({
          name: `${propertyName(property)}/dataRetentionSettings`,
          updateMask: Object.keys(requestBody).join(','),
          requestBody,
        })
      ).data;
    },
  );

  // ── User access ─────────────────────────────────────────────────────────
  const accessTarget = {
    account: account.optional(),
    property: property.optional(),
  };
  const accessParent = (a: { account?: string; property?: string }) => {
    if (a.property) return propertyName(a.property);
    if (a.account) return accountName(a.account);
    throw new Error('Pass either account or property.');
  };
  const accessResource = (admin: any, parent: string) =>
    parent.startsWith('properties/') ? admin.properties.accessBindings : admin.accounts.accessBindings;

  defineTool(
    server,
    'ga_list_users',
    { description: 'Lists users and their roles on an account or property.', annotations: READ },
    accessTarget,
    async (a) => {
      const parent = accessParent(a);
      const res = accessResource(await alpha(), parent);
      return listAll((pageToken) => res.list({ parent, pageSize: 200, pageToken }), 'accessBindings');
    },
  );

  defineTool(
    server,
    'ga_add_user',
    { description: 'Grants a Google user access to an account or property.', annotations: WRITE },
    {
      ...accessTarget,
      email: z.string().email(),
      roles: z
        .array(z.enum(['viewer', 'analyst', 'editor', 'admin', 'no-cost-data', 'no-revenue-data']))
        .default(['viewer']),
    },
    async ({ email, roles, ...a }) => {
      const parent = accessParent(a);
      return (
        await accessResource(await alpha(), parent).create({
          parent,
          requestBody: { user: email, roles: roles.map((r) => `predefinedRoles/${r}`) },
        })
      ).data;
    },
  );

  defineTool(
    server,
    'ga_remove_user',
    {
      description: 'Removes an access binding (get its name from ga_list_users). Only call after the user explicitly confirmed.',
      annotations: DESTRUCTIVE,
    },
    { accessBinding: z.string().describe('Resource name, e.g. accounts/1/accessBindings/abc') },
    async ({ accessBinding }) => {
      const admin = await alpha();
      const res = accessBinding.startsWith('properties/') ? admin.properties.accessBindings : admin.accounts.accessBindings;
      await res.delete({ name: accessBinding });
      return { deleted: accessBinding };
    },
  );

  // ── Escape hatch ────────────────────────────────────────────────────────
  defineTool(
    server,
    'ga_admin_api',
    {
      title: 'Raw GA Admin API call',
      description:
        'Calls any Google Analytics Admin API method not covered by a dedicated tool (Google Ads links, Firebase links, audiences, channel groups, event create rules, change history, …). `method` is the dotted resource path of the googleapis client, e.g. "properties.googleAdsLinks.list", "properties.audiences.create", "accounts.searchChangeHistoryEvents". `params` are the method params, with the request body under `requestBody`. Use version v1alpha for alpha-only resources.',
      annotations: { openWorldHint: true },
    },
    {
      version: z.enum(['v1beta', 'v1alpha']).default('v1beta'),
      method: z.string(),
      params: z.record(z.string(), z.any()).default({}),
    },
    async ({ version, method, params }) =>
      callByPath(version === 'v1alpha' ? await alpha() : await beta(), method, params),
  );
}
