import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { getConnectionService } from '../../../packages/daemon/src/lib/connections/operations.ts';
import type { ConnectionStatus } from '../../../packages/daemon/src/lib/connections/status.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { artifactIdentityWrites } from '../../../packages/daemon/src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../packages/daemon/src/storage/repositories/google-connections-worker.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const tenant = '11111111-2222-4333-8444-555555555555';
const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
let now = Date.now(), mode = 'grant', phase = '';
const requests: { phase: string; url: string; refreshToken: string | null; scope: string | null; secret: boolean }[] = [];
const observations: unknown[] = [];
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const form = new URLSearchParams(String(init?.body));
  requests.push({ phase, url: String(url), refreshToken: form.get('refresh_token'), scope: form.get('scope'), secret: form.has('client_secret') });
  assert.equal(String(url), tokenUrl, 'external network refused');
  assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('client_id'), 'synthetic-microsoft-client');
  if (mode === 'invalid') return Response.json({ error: 'invalid_grant' }, { status: 400 });
  await new Promise((done) => setTimeout(done, 50));
  const count = requests.length;
  return Response.json({ access_token: `synthetic-access-${count}`, refresh_token: `synthetic-refresh-${count}`, expires_in: 3600, token_type: 'Bearer', scope: 'Mail.ReadWrite Calendars.Read' });
}) as typeof fetch;
const createStore = (db: ConstructorParameters<typeof DatabaseCredentialStore>[0]) => new DatabaseCredentialStore(db, 'synthetic-proof-key');
const deps = { createStore, fetchImpl, now: () => now, schedule: () => () => {} };
type App = Awaited<ReturnType<typeof createDaemonApp>>;
const boot = () => createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data', `${phase}.db`) }), verbose: false, googleConnections: deps });
async function rpc(app: App, name: string, input: unknown = {}) {
  const ws = createLocalSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('Isolated RPC unavailable')); });
    const value = await new Promise<ReturnType<typeof JSON.parse>>((done, fail) => {
      const id = crypto.randomUUID(), timeout = setTimeout(() => fail(new Error('Management RPC timed out')), 10000);
      ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); if (reply.id !== id && reply.requestId !== id) return; clearTimeout(timeout); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); };
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    });
    assert(!JSON.stringify(value).includes('synthetic-access') && !JSON.stringify(value).includes('synthetic-refresh'), `credential disclosure in ${name}`);
    observations.push({ phase, name, value }); return value;
  } finally { ws.close(); }
}
const connection: ConnectionStatus = { id: 'synthetic-microsoft', provider: 'microsoft', accountId: `${tenant}.synthetic-object`, email: 'one@example.test', scopes: ['Mail.ReadWrite', 'Calendars.Read'], health: 'healthy' };
async function vault(app: App) {
  return new ConnectionVault(createStore(app.db.getDatabase()), await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID()));
}
async function seed(app: App) {
  await app.db.gateway.call(googleConnectionWrites, 'put', connection);
  await (await vault(app)).replace(connection, { accessToken: 'synthetic-access-0', refreshToken: 'synthetic-refresh-0', expiresAt: now + 30000, scopes: connection.scopes, client: { clientId: 'synthetic-microsoft-client' } });
}
const token = async (app: App) => (await getConnectionService(app.db.getDatabase(), 'microsoft')).token(connection.id);
const health = async (app: App) => (await rpc(app, 'connections.list')).connections[0].health;
try {
  phase = 'rotation';
  let app = await boot();
  try {
    await seed(app);
    const first = await Promise.all(Array.from({ length: 10 }, () => token(app)));
    assert(first.every((result) => result.ok && result.accessToken === 'synthetic-access-1')); assert.equal(requests.length, 1);
    now += 3600000; assert.equal((await token(app) as { accessToken: string }).accessToken, 'synthetic-access-2');
    await app.cleanup(); app = await boot();
    assert.equal((await token(app) as { accessToken: string }).accessToken, 'synthetic-access-2'); assert.equal(requests.length, 2);
    now += 3600000; assert.equal((await token(app) as { accessToken: string }).accessToken, 'synthetic-access-3');
    assert.deepEqual(requests.map((request) => request.refreshToken), ['synthetic-refresh-0', 'synthetic-refresh-1', 'synthetic-refresh-2']);
    assert(requests.every((request) => request.scope === 'openid profile email offline_access Mail.ReadWrite Calendars.Read' && !request.secret));
    assert.equal((await (await vault(app)).read(connection))?.refreshToken, 'synthetic-refresh-3');
    assert(!JSON.stringify(app.db.getDatabase().prepare('SELECT * FROM provider_credentials').all()).includes('synthetic-refresh-3'));
    assert.equal(await health(app), 'healthy');
  } finally { await app.cleanup(); }
  phase = 'invalid'; mode = 'invalid'; now = Date.now();
  app = await boot();
  try {
    await seed(app);
    assert.deepEqual(await token(app), { ok: false, reason: 'reconnect_needed' });
    assert.equal(await health(app), 'reconnect_needed');
    now += 86400000; assert.deepEqual(await token(app), { ok: false, reason: 'reconnect_needed' });
    await app.cleanup(); app = await boot();
    assert.equal(await health(app), 'reconnect_needed'); assert.deepEqual(await token(app), { ok: false, reason: 'reconnect_needed' });
    assert.equal(requests.filter((request) => request.phase === 'invalid').length, 1);
  } finally { await app.cleanup(); }
  console.log('PASS: Microsoft refresh at the account tenant, single flight, rotation across restart, invalid_grant to reconnect needed with no retry; no credentials in replies');
} finally {
  writeFileSync(join(run, 'evidence/microsoft-refresh.json'), JSON.stringify({ runtime: process.versions, surface: 'isolated daemon; token access through the daemon Microsoft connection service, health through real management RPC; fake clock and fake identity endpoint', observations, requests: requests.map(({ refreshToken: _, ...rest }) => rest) }, null, 2));
}
