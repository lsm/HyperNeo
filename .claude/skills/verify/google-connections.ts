import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { startGoogleLogin } from '../../../packages/daemon/src/lib/connections/google-login.ts';
import { createGoogleConnectionOperations } from '../../../packages/daemon/src/lib/connections/operations.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
let authorization: URLSearchParams;
let exchanges = 0;
let subject = 'synthetic-subject-1';
const evidence: unknown[] = [];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/certs') return Response.json({ keys: [jwk] });
  if (url.pathname === '/authorize') {
    authorization = url.searchParams;
    assert.equal(authorization.get('code_challenge_method'), 'S256');
    assert.equal(authorization.get('access_type'), 'offline');
    const callback = new URL(authorization.get('redirect_uri')!);
    assert.equal(callback.hostname, '127.0.0.1');
    assert.notEqual(callback.port, '8399');
    callback.search = new URLSearchParams({ code: 'synthetic-code', state: authorization.get('state')! }).toString();
    return Response.redirect(callback.toString(), 302);
  }
  assert.equal(url.pathname, '/token');
  exchanges++;
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get('redirect_uri'), authorization.get('redirect_uri'));
  assert.equal(form.get('client_id'), authorization.get('client_id'));
  assert.equal(form.get('code'), 'synthetic-code');
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), authorization.get('code_challenge'));
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, email: 'one@example.test', email_verified: true, nonce: authorization.get('nonce'), iss: 'https://accounts.google.com', aud: authorization.get('client_id'), exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, scope: 'openid email', token_type: 'Bearer', id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}` });
} });
assert.notEqual(fake.port, 8399);
const origin = `http://127.0.0.1:${fake.port}`;
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const routes: Record<string, string> = { 'https://oauth2.googleapis.com/token': '/token', 'https://www.googleapis.com/oauth2/v3/certs': '/certs' };
  assert(routes[String(url)], 'external network refused');
  return fetch(`${origin}${routes[String(url)]}`, init);
}) as typeof fetch;
let firstId = '', secondId = '', oldLogin = '';
try {
  for (const phase of ['initial', 'restart']) {
    const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
    let ws: WebSocket | undefined;
    try {
      assert.notEqual(app.server.port, 8399);
      await app.jobProcessor.stop();
      const base = app.sessionManager.getOperationRegistry();
      const registry = createOperationRegistry([
        ...base.entries.filter((entry) => !entry.name.startsWith('connections.google.')),
        ...createGoogleConnectionOperations(() => app.db.getDatabase(), {
          createStore: (db) => new DatabaseCredentialStore(db, 'synthetic-proof-key'),
          startLogin: (client) => startGoogleLogin(client, { fetchImpl }),
        }),
      ]);
      app.sessionManager.setOperationRegistryProvider(() => registry);
      ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
      await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WebSocket unavailable')); });
      const call = (name: string, input: unknown = {}) => new Promise<any>((done, fail) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => fail(new Error('Google management RPC timed out')), 10000);
        ws!.onmessage = (event) => {
          const reply = JSON.parse(String(event.data));
          if (reply.id !== id && reply.requestId !== id) return;
          clearTimeout(timer);
          evidence.push({ phase, name, reply });
          if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
        };
        ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
      });
      const connect = async (connectionId?: string) => {
        const start = await call('connections.google.connect', { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret', connectionId });
        assert.equal(start.state, 'pending');
        const authorize = new URL(start.authorizeUrl);
        const consent = await fetch(`${origin}/authorize?${authorize.searchParams}`, { redirect: 'manual' });
        const callback = await fetch(consent.headers.get('location')!);
        assert.equal(callback.status, 200);
        assert(!(await callback.text()).includes('synthetic-access'));
        const until = Date.now() + 10000;
        for (;;) {
          const view = await call('connections.google.login', { loginId: start.loginId });
          if (view.state !== 'pending') return view;
          assert(Date.now() < until, 'login did not settle');
          await new Promise((done) => setTimeout(done, 20));
        }
      };
      const mcp = createOperationMcpHandler(() => registry, () => ({ sessionId: 'synthetic-worker', role: 'neo' }));
      const refused = await mcp({ name: 'connections.google.connect', input: { clientId: 'synthetic-client' } });
      assert.equal(refused.isError, true);
      assert.equal(JSON.parse(refused.content[0].text).code, 'forbidden');
      if (phase === 'initial') {
        assert.deepEqual((await call('connections.list')).connections, []);
        const first = await connect(); assert.equal(first.state, 'complete'); firstId = first.connectionId;
        subject = 'synthetic-subject-2';
        const second = await connect(); assert.equal(second.state, 'complete'); secondId = second.connectionId;
        assert.notEqual(firstId, secondId);
        const mismatch = await connect(firstId);
        assert.equal(mismatch.state, 'failed'); assert.equal(mismatch.reason, 'account_mismatch');
        assert.equal((await call('connections.list')).connections.filter((row: any) => row.health === 'healthy').length, 2);
        oldLogin = (await call('connections.google.connect', { clientId: 'synthetic-client', connectionId: firstId })).loginId;
      } else {
        const connections = (await call('connections.list')).connections;
        assert.equal(connections.length, 2); assert(connections.every((row: any) => row.health === 'healthy'));
        assert.equal((await call('connections.google.login', { loginId: oldLogin })).state, 'missing');
        assert.deepEqual(await call('connections.google.disconnect', { connectionId: firstId }), { ok: true });
        const after = (await call('connections.list')).connections;
        assert.equal(after.find((row: any) => row.id === firstId).health, 'disconnected');
        assert.equal(after.find((row: any) => row.id === secondId).health, 'healthy');
        const encrypted = app.db.getDatabase().prepare('SELECT * FROM provider_credentials').all();
        assert.equal(encrypted.length, 1);
        assert(!JSON.stringify(encrypted).includes('synthetic-access'));
        evidence.push({ phase, survivingBundles: encrypted.length, metadataRetained: after.length });
      }
    } finally { ws?.close(); await app.cleanup(); }
  }
} finally { fake.stop(true); }
const text = JSON.stringify({ surface: 'real WebSocket management operations with production lifecycle/vault and a fake-Google transport seam; restart and agent MCP refusal', evidence, resourcesClosed: true }, null, 2);
for (const secret of ['synthetic-access', 'synthetic-refresh', 'synthetic-client-secret']) assert(!text.includes(secret));
writeFileSync(join(run, 'evidence/google-connections.json'), text);
console.log('PASS: real RPC fake login, two accounts, wrong-account reconnect refused, restart, disconnect isolation, no RPC tokens and agent MCP refused; resources closed');
