import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert(!process.env[key]);
mkdirSync(join(run, 'evidence'), { recursive: true });
const graph = 'https://graph.microsoft.com';
const rows = [
  { id: 'outlook-one', provider: 'microsoft' as const, accountId: '11111111-2222-4333-8444-555555555555.synthetic-object', email: 'one@example.test', scopes: ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite', 'Calendars.Read'], health: 'healthy' as const },
  { id: 'gmail-one', provider: 'google' as const, accountId: 'synthetic-subject', email: 'g@example.test', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], health: 'healthy' as const },
];
let mode = 'normal';
const requests: { mode: string; path: string; query: string; prefer: string | null }[] = [];
const observations: unknown[] = [];
const message = (id: string) => ({ id, conversationId: 'conversation-one', subject: `Fixture ${id}`, receivedDateTime: '2026-11-18T12:00:00Z', bodyPreview: `Untrusted preview synthetic-access-token ${'p'.repeat(600)}`, from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } }, toRecipients: [{ emailAddress: { name: 'One', address: 'one@example.test' } }] });
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-access-token');
  requests.push({ mode, path: url.pathname, query: url.search, prefer: request.headers.get('prefer') });
  if (mode === 'rate') return new Response('synthetic-sensitive-error', { status: 429 });
  if (url.pathname === '/v1.0/me/messages') {
    assert(!url.searchParams.get('$select')?.split(',').includes('body'), 'list calls never select body');
    if (url.searchParams.get('$filter')) {
      assert.equal(url.searchParams.get('$filter'), "conversationId eq 'conversation-one'");
      return Response.json({ value: ['m1', 'm2', 'm3'].map(message) });
    }
    if (url.searchParams.get('$skiptoken')) return Response.json({ value: [message('page-two')] });
    assert.equal(url.searchParams.get('$search'), '"fixture"');
    const nextLink = mode === 'foreign-next' ? 'https://attacker.example/v1.0/me/messages?$skiptoken=x' : `${graph}/v1.0/me/messages${url.search}&$skiptoken=page-two`;
    return Response.json({ value: [message('page-one')], '@odata.nextLink': nextLink });
  }
  assert.equal(request.headers.get('prefer'), 'outlook.body-content-type="text"');
  const id = url.pathname.split('/').at(-1)!;
  return Response.json({ id, body: { contentType: 'text', content: id === 'm2' ? 'b'.repeat(80 * 1024) : `Body of ${id}` } });
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  assert.equal(target.origin, graph, 'external network refused');
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
    await vault.replace(row, { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt: Date.now() + 3600000, scopes: row.scopes, client: { clientId: 'synthetic-client' } });
  }
  let caller = { sessionId: 'synthetic-worker', role: 'neo' as 'neo' | 'universal_read' };
  const mcp = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => caller);
  const invoke = async (name: string, input: unknown = {}) => {
    const value = JSON.parse((await mcp({ name, input })).content[0].text);
    observations.push({ mode, name, input, value });
    const text = JSON.stringify(value);
    for (const forbidden of ['synthetic-access-token', 'synthetic-refresh-token', 'synthetic-proof-key', 'synthetic-sensitive-error', 'graph.microsoft.com']) assert(!text.includes(forbidden), `leaked: ${forbidden}`);
    return value;
  };
  const search = (extra: Record<string, unknown> = {}) => invoke('outlook.search', { connectionId: 'outlook-one', query: 'fixture', limit: 2, ...extra });
  const read = (extra: Record<string, unknown> = {}) => invoke('outlook.read_thread', { connectionId: 'outlook-one', conversationId: 'conversation-one', limit: 3, ...extra });

  const accounts = await invoke('microsoft.accounts');
  assert.deepEqual(accounts.connections.map((row: { id: string }) => row.id), ['outlook-one']);
  assert(!JSON.stringify(accounts).includes('synthetic-object'));

  const first = await search();
  assert.equal(first.ok, true); assert.equal(first.untrusted, true); assert.equal(first.truncated, true);
  assert.equal(first.items[0].preview.length, 256); assert(first.items[0].preview.includes('[redacted]'));
  assert.equal(first.items[0].from, 'Sender <sender@example.test>');
  const second = await search({ cursor: first.nextCursor });
  assert.equal(second.items[0].id, 'page-two'); assert.equal(second.nextCursor, undefined);
  assert.equal(new URL(`${graph}${requests.at(-1)!.path}${requests.at(-1)!.query}`).searchParams.get('$skiptoken'), 'page-two');

  let before = requests.length;
  assert.equal((await search({ cursor: first.nextCursor, query: 'other' })).reason, 'invalid_cursor');
  assert.equal((await search({ cursor: 'forged' })).reason, 'invalid_cursor');
  const crafted = Buffer.from(JSON.stringify({ connectionId: 'outlook-one', operation: 'outlook.search', key: createHash('sha256').update('fixture').digest('hex'), query: '/../../users/other/messages?$top=1' })).toString('base64url');
  assert.equal((await search({ cursor: crafted })).reason, 'invalid_cursor');
  const minted = Buffer.from(JSON.stringify({ connectionId: 'outlook-one', operation: 'outlook.search', key: createHash('sha256').update('fixture').digest('hex'), query: '?$top=1&$select=id,body', sig: '0'.repeat(64) })).toString('base64url');
  assert.equal((await search({ cursor: minted })).reason, 'invalid_cursor');
  assert.equal((await read({ cursor: first.nextCursor })).reason, 'invalid_cursor');
  assert.equal((await invoke('outlook.search', { connectionId: 'gmail-one', query: 'fixture' })).reason, 'unknown_connection');
  caller = { sessionId: '', role: 'universal_read' };
  assert.equal((await search()).reason, 'session_required');
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  assert.equal(requests.length, before, 'refused calls sent no Graph request');

  mode = 'foreign-next';
  assert.equal((await search()).reason, 'invalid_response');
  mode = 'rate';
  assert.equal((await search()).reason, 'rate_limited');
  mode = 'normal';

  const plain = await read();
  assert.deepEqual(plain.items.map((item: { id: string }) => item.id), ['m1', 'm2', 'm3']);
  assert(plain.items.every((item: { body?: string }) => item.body === undefined));
  before = requests.length;
  const bodies = await read({ body: true });
  assert.equal(requests.length - before, 4);
  assert.equal(bodies.items[0].body, 'Body of m1'); assert.equal(bodies.items[2].body, 'Body of m3');
  assert.equal(bodies.items[1].body, undefined); assert.equal(bodies.items[1].truncated, true);
  assert(bodies.items[1].preview.length > 0);
} finally {
  await app?.cleanup();
  fake.stop(true);
  writeFileSync(join(run, 'evidence/outlook-mail.json'), JSON.stringify({ runtime: process.versions, requests, observations }, null, 2));
}
process.stdout.write('PASS: Outlook accounts, bounded search, cursor refusals, thread bodies and redaction through the real daemon operations MCP; resources closed\n');
