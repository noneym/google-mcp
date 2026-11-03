import { auth } from '@googleapis/analyticsadmin';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

type OAuth2Client = InstanceType<typeof auth.OAuth2>;

/**
 * Scopes requested at login. New Google services get their scope added here;
 * existing users then need to run `login` again to grant it.
 */
export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.manage.users',
  'https://www.googleapis.com/auth/analytics.provision',
];

export const HOME = process.env.GOOGLE_MCP_HOME || join(homedir(), '.google-mcp');
const TOKEN_FILE = process.env.GOOGLE_MCP_TOKEN_FILE || join(HOME, 'token.json');
const CLIENT_FILE = process.env.GOOGLE_OAUTH_CLIENT_FILE || join(HOME, 'client_secret.json');

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

function loadClientCreds(): ClientCreds | null {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET };
  }
  if (existsSync(CLIENT_FILE)) {
    const raw = JSON.parse(readFileSync(CLIENT_FILE, 'utf8'));
    const c = raw.installed ?? raw.web ?? raw;
    if (c.client_id && c.client_secret) return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  return null;
}

function readToken(): Record<string, any> | null {
  if (process.env.GOOGLE_REFRESH_TOKEN) return { refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  if (!existsSync(TOKEN_FILE)) return null;
  return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
}

function writeToken(token: Record<string, any>) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function newOAuthClient(creds: ClientCreds, redirectUri?: string): OAuth2Client {
  return new auth.OAuth2({ clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri });
}

let cached: any = null;

/** Returns an authorized client usable by any @googleapis/* package. */
export async function getAuthClient(): Promise<any> {
  if (cached) return cached;

  const creds = loadClientCreds();
  const token = readToken();
  if (creds && token?.refresh_token) {
    const client = newOAuthClient(creds);
    client.setCredentials(token);
    client.on('tokens', (t) => {
      if (process.env.GOOGLE_REFRESH_TOKEN) return;
      writeToken({ ...readToken(), ...t });
    });
    cached = client;
    return client;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    cached = await new auth.GoogleAuth({ scopes: SCOPES.filter((s) => s.startsWith('https://')) }).getClient();
    return cached;
  }

  throw new Error(
    creds
      ? 'Not logged in to Google. Call the `google_login` tool (or run `npm run login` in the google-mcp folder) first.'
      : `No OAuth client configured. Put the Desktop OAuth client JSON at ${CLIENT_FILE} or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, then log in.`,
  );
}

export function resetAuthCache() {
  cached = null;
}

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // The caller prints/returns the URL anyway.
  }
}

export interface LoginSession {
  url: string;
  /** Resolves with the signed-in email once the browser flow completes. */
  done: Promise<string | undefined>;
}

/**
 * Starts the OAuth loopback flow: a one-shot local HTTP server receives the
 * redirect, exchanges the code and stores the refresh token.
 */
export async function startLogin(timeoutMs = 5 * 60_000): Promise<LoginSession> {
  const creds = loadClientCreds();
  if (!creds) {
    throw new Error(
      `No OAuth client configured. Download a "Desktop app" OAuth client JSON from Google Cloud Console and save it as ${CLIENT_FILE} (or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).`,
    );
  }

  const state = randomBytes(16).toString('hex');
  const server = createServer();
  const port = Number(process.env.GOOGLE_MCP_OAUTH_PORT || 0);
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res());
  });
  const actualPort = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${actualPort}/oauth2callback`;
  const client = newOAuthClient(creds, redirectUri);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: true,
    scope: SCOPES,
    state,
  });

  const done = new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Login timed out.'));
    }, timeoutMs);

    server.on('request', async (req, res) => {
      const u = new URL(req.url || '/', redirectUri);
      if (u.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, msg: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>google-mcp</title><body style="font-family:system-ui;padding:40px"><h2>${msg}</h2><p>Bu pencereyi kapatabilirsiniz.</p></body>`);
        clearTimeout(timer);
        server.close();
      };
      try {
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error')!);
        if (u.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const { tokens } = await client.getToken({ code: u.searchParams.get('code')!, redirect_uri: redirectUri });
        if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; revoke the app access and retry.');
        let email: string | undefined;
        try {
          email = (await client.getTokenInfo(tokens.access_token!)).email;
        } catch {}
        writeToken({ ...tokens, email });
        resetAuthCache();
        finish(200, `Google girişi tamamlandı${email ? ` (${email})` : ''}.`);
        resolve(email);
      } catch (e) {
        finish(400, `Giriş başarısız: ${(e as Error).message}`);
        reject(e);
      }
    });
  });

  return { url, done };
}

export function logout() {
  if (existsSync(TOKEN_FILE)) rmSync(TOKEN_FILE);
  resetAuthCache();
}

export function authStatus() {
  const token = readToken();
  return {
    clientConfigured: !!loadClientCreds(),
    clientFile: CLIENT_FILE,
    tokenFile: TOKEN_FILE,
    loggedIn: !!token?.refresh_token,
    email: token?.email,
    grantedScopes: typeof token?.scope === 'string' ? token.scope.split(' ') : undefined,
    serviceAccount: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
  };
}
