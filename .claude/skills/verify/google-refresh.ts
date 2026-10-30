import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import type { ConnectionStatus } from '../../../packages/daemon/src/lib/connections/status.ts';
import { artifactIdentityWrites } from '../../../packages/daemon/src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../packages/daemon/src/storage/repositories/google-connections-worker.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
let now = Date.now(), calls = 0, cancellations = 0, starts = 0, stops = 0;
let phase = '', mode = '', expectedRefresh = '';
let scheduled: (() => Promise<void>) | undefined;
const evidence: unknown[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  assert.equal(new URL(request.url).pathname, '/token');
  const form = new URLSearchParams(await request.text());
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), expectedRefresh);
  assert.equal(form.get('client_id'), 'synthetic-client');
  assert.equal(form.get('client_secret'), 'synthetic-client-secret');
  calls++;
  if (mode === 'invalid') return Response.json({ error: 'invalid_grant', error_description: 'synthetic-sensitive-detail' }, { status: 400 });
  if (mode === 'transient' && calls === 1) return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  const grant = { access_token: `synthetic-access-${calls}`, expires_in: 3600, token_type: 'Bearer', ...(mode === 'rotation' && calls === 1 ? { refresh_token: 'synthetic-rotated' } : {}) };
  if (mode === 'rotation' && calls === 1) expectedRefresh = 'synthetic-rotated';
  if (mode === 'hold') return new Promise<Response>((done) => {
    const timer = setTimeout(() => { timers.delete(timer); done(Response.json(grant)); }, 2000);
    timers.add(timer);
    request.signal.addEventListener('abort', () => { clearTimeout(timer); timers.delete(timer); done(Response.json(grant)); }, { once: true });
  });
  return Response.json(grant);
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  assert.equal(String(url), 'https://oauth2.googleapis.com/token', 'external network refused');
  const notice = () => { cancellations++; };
  init?.signal?.addEventListener('abort', notice, { once: true });
  return fetch(`http://127.0.0.1:${fake.port}/token`, init).finally(() => init?.signal?.removeEventListener('abort', notice));
}) as typeof fetch;
const deps = {
  createStore: (db: ConstructorParameters<typeof DatabaseCredentialStore>[0]) => new DatabaseCredentialStore(db, 'synthetic-proof-key'),
  startLogin: async () => { throw new Error('This refresh journey must never start consent'); },
  fetchImpl, now: () => now,
  schedule: (tick: () => Promise<void>) => { starts++; scheduled = tick; return () => { stops++; scheduled = undefined; }; },
};
type App = Awaited<ReturnType<typeof createDaemonApp>>;
async function boot() {
  const options = { config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, `data/${phase}.db`) }), verbose: false, googleConnections: deps };
  const app = await createDaemonApp(options);
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  await scheduled?.();
  return app;
}
async function call<T>(app: App, name: string, input: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('WebSocket unavailable')); });
    return await new Promise<T>((done, fail) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => fail(new Error('Management RPC timed out')), 10000);
      ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timer); if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
  } finally { ws.close(); }
}
const connection: ConnectionStatus = { id: 'synthetic-connection', accountId: 'synthetic-subject', provider: 'google', email: 'one@example.test', scopes: ['openid', 'email'], health: 'healthy' };
async function seed(app: App) {
  const identity = await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID());
  const vault = new ConnectionVault(deps.createStore(app.db.getDatabase()), identity);
  await app.db.gateway.call(googleConnectionWrites, 'put', connection);
  await vault.replace(connection, { accessToken: 'synthetic-old-access', refreshToken: expectedRefresh, expiresAt: now + 180000, scopes: connection.scopes, client: { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' } });
}
const advance = async (ms: number) => { now += ms; await scheduled?.(); };
async function status(app: App) {
  const value = await call<{ connections: ConnectionStatus[] }>(app, 'connections.list');
  evidence.push({ phase, calls, value });
  return value.connections[0];
}
async function waitForRequest() {
  const until = Date.now() + 5000;
  while (calls === 0) { assert(Date.now() < until, 'refresh request never started'); await new Promise((done) => setTimeout(done, 10)); }
}
try {
  for (phase of ['invalid', 'rotation', 'transient', 'disconnect', 'shutdown']) {
    calls = 0; now = Date.now(); expectedRefresh = 'synthetic-refresh'; mode = phase;
    let app = await boot();
    try {
      await seed(app);
      if (phase === 'invalid') {
        await advance(60000);
        assert.equal((await status(app)).health, 'reconnect_needed');
        assert.equal(calls, 1);
        await advance(28800000); assert.equal(calls, 1);
        await app.cleanup(); app = await boot();
        assert.equal((await status(app)).health, 'reconnect_needed'); assert.equal(calls, 1);
      } else if (phase === 'rotation') {
        await advance(60000); assert.equal(calls, 1);
        assert.equal((await status(app)).health, 'healthy');
        await Promise.all([advance(0), advance(0), advance(0)]); assert.equal(calls, 1);
        for (let restart = 0; restart < 2; restart++) {
          await app.cleanup(); now += 3540000; app = await boot();
          assert.equal(calls, restart + 2); assert.deepEqual((await status(app)).scopes, connection.scopes);
        }
        const encrypted = app.db.getDatabase().prepare('SELECT * FROM provider_credentials').all();
        assert(!JSON.stringify(encrypted).includes('synthetic-rotated'));
      } else if (phase === 'transient') {
        await advance(60000); assert.equal(calls, 1);
        await advance(30000); assert.equal(calls, 1);
        await advance(31000); assert.equal(calls, 2);
        assert.equal((await status(app)).health, 'healthy');
      } else {
        mode = 'hold'; const before = cancellations;
        const active = advance(60000); await waitForRequest();
        if (phase === 'disconnect') {
          assert.deepEqual(await call(app, 'connections.google.disconnect', { connectionId: connection.id }), { ok: true });
          await active; assert.equal((await status(app)).health, 'disconnected');
          assert.equal(app.db.getDatabase().prepare('SELECT * FROM provider_credentials').all().length, 0);
          await advance(60000); assert.equal(calls, 1);
        } else {
          await app.cleanup(); await active; mode = 'normal'; app = await boot();
          assert.equal(calls, 2); assert.equal((await status(app)).health, 'healthy');
        }
        assert(cancellations > before, 'in-flight fetch was not aborted');
      }
    } finally { await app.cleanup(); }
  }
} finally { for (const timer of timers) clearTimeout(timer); fake.stop(true); }
assert.equal(starts, stops); assert.equal(scheduled, undefined);
const text = JSON.stringify({ surface: 'isolated daemon with real management RPC, fake clock scheduler and fake Google HTTP; no token RPC', evidence, starts, stops, resourcesClosed: true }, null, 2);
for (const secret of ['synthetic-access-', 'synthetic-rotated', 'synthetic-refresh', 'synthetic-client-secret', 'synthetic-sensitive-detail']) assert(!text.includes(secret));
writeFileSync(join(run, 'evidence/google-refresh.json'), text);
console.log('PASS: proactive refresh, rotation/omission across restart, single-flight ticks, invalid_grant health, backoff, disconnect and shutdown cancellation; resources closed');
