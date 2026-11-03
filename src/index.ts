#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAdminTools } from './analytics/admin.js';
import { registerDataTools } from './analytics/data.js';
import { authStatus, logout, openBrowser, startLogin } from './auth.js';
import { z } from 'zod';
import { serveHttp } from './http.js';
import { defineTool } from './util.js';

function buildServer(remote = false) {
  const server = new McpServer(
    { name: 'google-mcp', version: '0.1.0' },
    {
      instructions:
        'Google services. Analytics: start with ga_list_account_summaries to find account/property ids; ga_setup_website creates a property + web stream and returns the G- id; ga_get_visitors / ga_realtime / ga_quick_report read traffic. If a call says not logged in, call google_login and give the user the URL. Deleting accounts/properties/streams needs explicit user confirmation.',
    },
  );

  defineTool(
    server,
    'google_auth_status',
    { description: 'Shows whether google-mcp is logged in, which Google account and which scopes.', annotations: { readOnlyHint: true } },
    {},
    async () => authStatus(),
  );

  if (!remote) registerLocalAuthTools(server);
  registerAdminTools(server);
  registerDataTools(server);
  return server;
}

/** Login/logout need a browser on this machine, so they are not offered over HTTP. */
function registerLocalAuthTools(server: McpServer) {
  defineTool(
    server,
    'google_login',
    {
      description:
        'Starts Google OAuth login: opens the consent page in the local browser and returns the URL (give it to the user in case the browser did not open). The token is stored automatically once the user approves; check with google_auth_status.',
    },
    { openBrowser: z.boolean().default(true) },
    async ({ openBrowser: open }) => {
      const { url, done } = await startLogin();
      done.catch((e) => console.error('[google-mcp] login failed:', e.message));
      if (open) openBrowser(url);
      return { loginUrl: url, note: 'Waiting up to 5 minutes for the user to approve in the browser.' };
    },
  );

  defineTool(
    server,
    'google_logout',
    { description: 'Deletes the stored Google token.', annotations: { destructiveHint: true } },
    {},
    async () => {
      logout();
      return { loggedOut: true };
    },
  );
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'login') {
    const { url, done } = await startLogin();
    console.log(`Tarayıcıda açılıyor (açılmazsa bu adrese git):\n\n${url}\n`);
    openBrowser(url);
    const email = await done;
    console.log(`Giriş tamam${email ? `: ${email}` : ''}. Token: ${authStatus().tokenFile}`);
    return;
  }
  if (cmd === 'status') {
    console.log(JSON.stringify(authStatus(), null, 2));
    return;
  }
  if (cmd === 'logout') {
    logout();
    console.log('Token silindi.');
    return;
  }
  if (cmd === 'serve' || process.env.MCP_TRANSPORT === 'http') {
    serveHttp(() => buildServer(true));
    return;
  }
  await buildServer().connect(new StdioServerTransport());
}


main().catch((e) => {
  console.error(e);
  process.exit(1);
});
