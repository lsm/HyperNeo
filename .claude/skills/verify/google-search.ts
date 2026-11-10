import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { DatabaseCredentialStore } from '../../../packages/daemon/src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../packages/daemon/src/lib/connections/vault.ts';
import { artifactIdentityWrites } from '../../../packages/daemon/src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../packages/daemon/src/storage/repositories/google-connections-worker.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const rows = ['one', 'two'].map((id) => ({ id, provider: 'google' as const, accountId: `synthetic-subject-${id}`, email: `${id}@example.test`, scopes: [scope], health: 'healthy' as const }));
let mode = 'normal', refreshes = 0, cancelled = 0, closed = false;
const requests: { mode: string; account: string; path: string; cursor: string | null }[] = [];
const observations: unknown[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/token') {
    assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    const id = rows.find((row) => form.get('refresh_token') === `synthetic-refresh-${row.id}`)?.id;
    assert(id); assert.equal(form.get('client_id'), 'synthetic-client');
    refreshes++;
    return Response.json({ access_token: `synthetic-renewed-${id}`, expires_in: 3600, token_type: 'Bearer' });
  }
  assert.equal(request.method, 'GET');
  const token = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
  const account = rows.find((row) => [`synthetic-access-${row.id}`, `synthetic-renewed-${row.id}`].includes(token))?.id;
  assert(account);
  requests.push({ mode, account, path: url.pathname, cursor: url.searchParams.get('pageToken') });
  if (mode === 'timeout' || mode === 'disconnect') return new Promise<Response>((done) => {
    const timer = setTimeout(() => { timers.delete(timer); done(Response.json({ messages: [] })); }, 2000);
    timers.add(timer);
    request.signal.addEventListener('abort', () => { cancelled++; clearTimeout(timer); timers.delete(timer); done(Response.json({ messages: [] })); }, { once: true });
  });
  if (mode === 'rate') return new Response('synthetic-sensitive-error', { status: 429 });
  if (mode === 'always-unauthorized' || (mode === 'unauthorized' && token.startsWith('synthetic-access-'))) return new Response('synthetic-sensitive-error', { status: 401 });
  if (mode === 'oversized') return new Response('x'.repeat(65537));
  if (mode === 'redirect') return Response.redirect('https://example.invalid/not-allowed');
  if (url.pathname.endsWith('/messages')) {
    assert.equal(url.searchParams.get('q'), 'subject:fixture');
    const limit = Number(url.searchParams.get('maxResults'));
    assert(limit >= 1 && limit <= 10);
    return Response.json({ messages: Array.from({ length: mode === 'too-many' ? limit + 1 : 1 }, (_, index) => ({ id: `${account}-${url.searchParams.has('pageToken') ? 'next' : index}`, threadId: `thread-${account}` })), ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'opaque-next' }) });
  }
  assert.equal(url.searchParams.get('format'), 'metadata');
  assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['Subject', 'From', 'Date']);
  return Response.json({ id: url.pathname.split('/').at(-1), threadId: `thread-${account}`, snippet: `Untrusted mail ${token} ${'x'.repeat(1000)}`, payload: { headers: [{ name: 'Subject', value: `Fixture ${account}` }, { name: 'From', value: 'sender@example.test' }], body: { data: 'synthetic-full-body-must-not-leak' } } });
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  assert(['https://gmail.googleapis.com', 'https://oauth2.googleapis.com'].includes(target.origin), 'external network refused');
  assert.equal(init?.redirect, 'error');
  return fetch(`http://127.0.0.1:${fake.port}${target.pathname}${target.search}`, init);
}) as typeof fetch;
const createStore = (db: ConstructorParameters<typeof DatabaseCredentialStore>[0]) => new DatabaseCredentialStore(db, 'synthetic-proof-key');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: { createStore, fetchImpl, apiTimeoutMs: 500, schedule: () => () => {} } });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const identity = await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID());
  const vault = new ConnectionVault(createStore(app.db.getDatabase()), identity);
  for (const row of rows) {
    await app.db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, { accessToken: `synthetic-access-${row.id}`, refreshToken: `synthetic-refresh-${row.id}`, expiresAt: Date.now() + 3600000, scopes: row.scopes, client: { clientId: 'synthetic-client' } });
  }
  let caller = { sessionId: 'synthetic-worker', role: 'neo' as 'neo' | 'universal_read' };
  const mcp = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => caller);
  const invoke = async (name: string, input: unknown = {}) => {
    const reply = await mcp({ name, input });
    const value = JSON.parse(reply.content[0].text);
    observations.push({ mode, name, value });
    const text = JSON.stringify(value);
    for (const forbidden of ['synthetic-access', 'synthetic-renewed', 'synthetic-refresh', 'synthetic-proof-key', 'synthetic-sensitive-error', 'synthetic-full-body']) assert(!text.includes(forbidden), `secret/body leaked: ${forbidden}`);
    return value;
  };
  const search = (connectionId = 'one', extra: Record<string, unknown> = {}) => invoke('gmail.search', { connectionId, query: 'subject:fixture', limit: 2, ...extra });
  const accounts = await invoke('google.accounts');
  assert.deepEqual(accounts.connections.map((row: { id: string }) => row.id), ['one', 'two']);
  assert(!JSON.stringify(accounts).includes('synthetic-subject'));
  let result = await search();
  assert.equal(result.ok, true); assert.equal(result.untrusted, true); assert.equal(result.truncated, true);
  assert.equal(result.items[0].subject, 'Fixture one'); assert.equal(result.items[0].snippet.length, 256); assert(result.items[0].snippet.includes('[redacted]'));
  result = await search('one', { cursor: result.nextCursor });
  assert.equal(result.items[0].id, 'one-next'); assert.equal(result.nextCursor, undefined);
  assert.equal((await search('two')).items[0].subject, 'Fixture two');
  let before = requests.length;
  assert.equal((await search('foreign')).reason, 'unknown_connection'); assert.equal(requests.length, before);
  caller = { sessionId: '', role: 'universal_read' };
  assert.equal((await invoke('google.accounts')).reason, 'session_required'); assert.equal((await search()).reason, 'session_required'); assert.equal(requests.length, before);
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  await vault.replace(rows[1], { accessToken: 'synthetic-access-two', refreshToken: 'synthetic-refresh-two', expiresAt: Date.now() + 3600000, scopes: [], client: { clientId: 'synthetic-client' } });
  assert.equal((await search('two')).reason, 'missing_scope'); assert.equal(requests.length, before);
  mode = 'unauthorized';
  assert.equal((await search()).ok, true); assert.equal(refreshes, 1);
  mode = 'always-unauthorized'; before = requests.length;
  assert.equal((await search()).reason, 'unauthorized'); assert.equal(requests.length - before, 2); assert.equal(refreshes, 2);
  for (const [scenario, reason] of [['rate', 'rate_limited'], ['oversized', 'invalid_response'], ['too-many', 'invalid_response'], ['redirect', 'request_failed'], ['timeout', 'timeout']]) {
    mode = scenario; before = requests.length;
    assert.equal((await search()).reason, reason); assert.equal(requests.length - before, 1);
  }
  mode = 'disconnect'; before = requests.length;
  const pending = search();
  const deadline = Date.now() + 3000;
  while (requests.length === before) { assert(Date.now() < deadline); await new Promise((done) => setTimeout(done, 5)); }
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  try {
    await new Promise<void>((done, fail) => { ws.onopen = () => done(); ws.onerror = () => fail(new Error('isolated RPC unavailable')); });
    const reply = new Promise<{ ok: boolean }>((done, fail) => { const timeout = setTimeout(() => fail(new Error('disconnect timed out')), 5000); ws.onmessage = (event) => { const value = JSON.parse(String(event.data)); if (value.id !== 'disconnect' && value.requestId !== 'disconnect') return; clearTimeout(timeout); value.error ? fail(new Error(JSON.stringify(value.error))) : done(value.data); }; });
    ws.send(JSON.stringify({ id: 'disconnect', type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'connections.google.disconnect', input: { connectionId: 'one' } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    assert.equal((await reply).ok, true);
  } finally { ws.close(); }
  assert.equal((await pending).reason, 'cancelled');
  before = requests.length; assert.equal((await search()).reason, 'disconnected'); assert.equal(requests.length, before);
} finally {
  await app?.cleanup();
  for (const timer of timers) clearTimeout(timer);
  fake.stop(true); closed = true;
  writeFileSync(join(run, 'evidence/google-search.json'), JSON.stringify({ runtime: process.versions, requests, refreshes, cancelled, observations, closed }, null, 2));
}
process.stdout.write('PASS: isolated daemon/MCP account routing, bounded Gmail search, refresh, errors and disconnect cancellation; resources closed\n');
