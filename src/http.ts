import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

function authorized(req: IncomingMessage, url: URL, token: string) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const given = Buffer.from(header || url.searchParams.get('token') || '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Stateless Streamable HTTP endpoint at /mcp, protected by MCP_AUTH_TOKEN. */
export function serveHttp(build: () => McpServer) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.length < 16) throw new Error('MCP_AUTH_TOKEN (min 16 chars) is required in HTTP mode.');
  const port = Number(process.env.PORT || 3000);

  createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req, url, token)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless mode: no server-initiated streams or sessions to delete.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    try {
      const body = await readBody(req);
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error('[google-mcp]', e);
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}');
    }
  }).listen(port, () => console.log(`google-mcp HTTP listening on :${port}/mcp`));
}
