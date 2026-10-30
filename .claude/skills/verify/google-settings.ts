import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { startGoogleLogin } from '../../../packages/daemon/src/lib/connections/google-login.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
let authorization: URLSearchParams;
let subject = 'synthetic-one', exchanges = 0;
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/fixture') { subject = (await request.json()).subject; return Response.json({ ok: true }); }
  if (url.pathname === '/certs') return Response.json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    authorization = url.searchParams;
    assert.equal(authorization.get('code_challenge_method'), 'S256');
    const callback = new URL(authorization.get('redirect_uri')!);
    assert.equal(callback.hostname, '127.0.0.1'); assert.notEqual(callback.port, '8399');
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: authorization.get('state')! }).toString();
    return new Response(`<h1>Fake Google consent</h1><p>Synthetic account only</p><a href="${callback.href.replaceAll('&', '&amp;')}">Approve synthetic account</a>`, { headers: { 'content-type': 'text/html' } });
  }
  assert.equal(url.pathname, '/token'); exchanges++;
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get('client_id'), 'synthetic-client');
  assert.equal(form.get('client_secret'), 'synthetic-secret');
  assert.equal(form.get('redirect_uri'), authorization.get('redirect_uri'));
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.get('code_challenge'));
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, email: subject === 'synthetic-one' ? 'one@example.test' : 'other@example.test', email_verified: true, nonce: authorization.get('nonce'), iss: 'https://accounts.google.com', aud: 'synthetic-client', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, token_type: 'Bearer', scope: scopes.join(' '), id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}` });
} });
assert.notEqual(fake.port, 8399);
const fakeOrigin = `http://127.0.0.1:${fake.port}`;
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const paths: Record<string, string> = { 'https://oauth2.googleapis.com/token': '/token', 'https://www.googleapis.com/oauth2/v3/certs': '/certs' };
  assert(paths[String(url)], 'external request refused');
  return fetch(`${fakeOrigin}${paths[String(url)]}`, init);
}) as typeof fetch;
let starts = 0, stops = 0;
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: {
      createStore: (db) => new DatabaseCredentialStore(db, 'synthetic-proof-key'), fetchImpl,
      startLogin: async (client) => { const login = await startGoogleLogin(client, { fetchImpl }); return { ...login, authorizeUrl: `${fakeOrigin}/authorize?${new URL(login.authorizeUrl).searchParams}` }; },
    } });
    starts++;
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
      const child = spawn('node', ['.claude/skills/verify/google-settings.mjs', String(port), fakeOrigin, run, phase], { env: process.env, stdio: 'inherit' });
      assert.equal(await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); }), 0, 'isolated browser proof failed');
    } finally { server?.stop(true); await app.cleanup(); stops++; }
  }
} finally { fake.stop(true); }
assert.equal(exchanges, 4); assert.equal(starts, stops);
writeFileSync(join(run, 'evidence/google-settings-runtime.json'), JSON.stringify({ surface: 'isolated daemon and headless browser, synthetic Google OAuth with real PKCE/OIDC validation', starts, stops, exchanges, resourcesClosed: true }, null, 2));
console.log('PASS: real Connections settings, consent, account mismatch, reconnect, restart persistence and disconnect; resources closed');
