import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const authority = 'https://login.microsoftonline.com';
const tenant = '11111111-2222-4333-8444-555555555555';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const requests: string[] = [];
let exchanges = 0;
function idToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid: 'synthetic-key' })}.${part({ iss: `${authority}/${tenant}/v2.0`, aud: 'synthetic-microsoft-client', tid: tenant, oid: 'synthetic-object', email: 'one@example.test', nonce, iat: now, exp: now + 3600 })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  requests.push(`${init?.method ?? 'GET'} ${target.origin}${target.pathname}`);
  assert.equal(target.origin, authority, 'external network refused');
  if (target.pathname === '/common/discovery/v2.0/keys') return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', issuer: `${authority}/{tenantid}/v2.0` }] });
  assert.equal(target.pathname, '/common/oauth2/v2.0/token');
  const form = new URLSearchParams(String(init?.body));
  assert.equal(form.get('client_id'), 'synthetic-microsoft-client'); assert.equal(form.get('client_secret'), null);
  exchanges++;
  const nonce = form.get('code')!.split('.')[1]!;
  return Response.json({ access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'Mail.ReadWrite Calendars.Read openid profile email', id_token: idToken(nonce) });
}) as typeof fetch;
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: {
  createStore: (db) => new DatabaseCredentialStore(db, 'synthetic-proof-key'), fetchImpl, schedule: () => () => {},
} });
let server: Awaited<ReturnType<typeof createHttpWsServer>> | undefined;
try {
  await app.jobProcessor.stop();
  const port = app.server.port; assert.notEqual(port, 8399); app.server.stop(true);
  const dist = resolve('packages/web/dist');
  const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  server = await createHttpWsServer({ hostname: '127.0.0.1', port, websocket: createWebSocketHandlers(app.transport, app.sessionManager), fetch: async (request, upgrade, client) => {
    const path = new URL(request.url).pathname;
    if (path === '/ws') return upgrade(request, { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, client?.remoteAddress ?? null) }) ?? new Response('Upgrade refused', { status: 500 });
    const file = resolve(dist, `.${path}`);
    if (!file.startsWith(`${dist}/`)) return new Response('Not found', { status: 404 });
    const asset = existsSync(file) && extname(file) ? file : join(dist, 'index.html');
    return new Response(readFileSync(asset), { headers: { 'content-type': types[extname(asset)] ?? 'text/html' } });
  } });
  const child = spawn('node', ['.claude/skills/verify/microsoft-settings.mjs', String(port), run], { env: process.env, stdio: 'inherit' });
  assert.equal(await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); }), 0, 'isolated browser proof failed');
} finally { server?.stop(true); await app.cleanup(); }
assert.equal(exchanges, 2);
writeFileSync(join(run, 'evidence/microsoft-settings-runtime.json'), JSON.stringify({ surface: 'isolated daemon and headless browser, fake Microsoft identity with real PKCE/ID-token validation', exchanges, requests, resourcesClosed: true }, null, 2));
console.log('PASS: Connect Microsoft in the real Connections panel, consent, reconnect and disconnect; resources closed');
