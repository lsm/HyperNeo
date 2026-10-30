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
let mode = 'normal', closed = false;
const requests: { mode: string; account: string; path: string; format: string | null }[] = [];
const observations: unknown[] = [];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  assert.equal(request.method, 'GET');
  const url = new URL(request.url);
  const account = rows.find((row) => request.headers.get('authorization') === `Bearer synthetic-access-${row.id}`)?.id;
  assert(account);
  requests.push({ mode, account, path: url.pathname, format: url.searchParams.get('format') });
  if (url.pathname.includes('/threads/')) {
    assert.equal(url.searchParams.get('format'), 'minimal');
    return Response.json({ id: 'thread-one', historyId: mode === 'changed' ? 'revision-two' : 'revision-one', messages: Array.from({ length: 3 }, (_, index) => ({ id: `${account}-message-${index}` })) });
  }
  if (url.pathname.includes('/attachments/')) {
    if (mode === 'attachment-error') return new Response('synthetic-sensitive-detail', { status: 429 });
    return Response.json({ size: mode === 'page-budget' ? 8192 : 3, data: (mode === 'page-budget' ? Buffer.alloc(8192) : Buffer.from([0, 1, 255])).toString('base64url') });
  }
  assert(url.pathname.includes('/messages/'));
  const full = url.searchParams.get('format') === 'full';
  const text = mode === 'body-limit' || mode === 'page-budget' ? 'x'.repeat(10000) : 'Hello 你好';
  const data = mode === 'latin' ? Buffer.from([99, 97, 102, 233]) : Buffer.from(text);
  const textPart = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: mode === 'latin' ? 'text/plain; charset=iso-8859-1' : 'text/plain; charset=utf-8' }], body: { data: data.toString('base64url'), size: data.length } };
  const files = Array.from({ length: mode === 'attachment-count' ? 5 : mode === 'page-budget' ? 2 : 1 }, (_, index) => ({ mimeType: 'application/octet-stream', filename: `fixture-${index}.bin`, body: { attachmentId: `attachment-${index}`, size: mode === 'attachment-limit' ? 100000 : mode === 'page-budget' ? 8192 : 3 } }));
  const parts = mode === 'part-count' ? Array.from({ length: 40 }, () => textPart) : [textPart, ...files];
  return Response.json({ id: url.pathname.split('/').at(-1), threadId: 'thread-one', snippet: 'Preview', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'Subject', value: `Fixture ${account}` }, { name: 'From', value: 'sender@example.test' }, { name: 'To', value: `${account}@example.test` }], ...(full ? { parts } : {}) } });
} });
assert.notEqual(fake.port, 8399);
const fetchImpl = ((url: string | URL, init?: RequestInit) => {
  const target = new URL(String(url));
  assert.equal(target.origin, 'https://gmail.googleapis.com', 'external network refused');
  assert.equal(init?.redirect, 'error');
  return fetch(`http://127.0.0.1:${fake.port}${target.pathname}${target.search}`, init);
}) as typeof fetch;
const createStore = (db: ConstructorParameters<typeof DatabaseCredentialStore>[0]) => new DatabaseCredentialStore(db, 'synthetic-proof-key');
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: { createStore, fetchImpl, schedule: () => () => {} } });
  assert.notEqual(app.server.port, 8399);
  await app.jobProcessor.stop();
  const identity = await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID());
  const vault = new ConnectionVault(createStore(app.db.getDatabase()), identity);
  for (const row of rows) {
    await app.db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, { accessToken: `synthetic-access-${row.id}`, refreshToken: `synthetic-refresh-${row.id}`, expiresAt: Date.now() + 3600000, scopes: row.scopes, client: { clientId: 'synthetic-client' } });
  }
  let caller = { sessionId: 'synthetic-worker', role: 'neo' as 'neo' | 'universal_read' };
  const registry = app.sessionManager.getOperationRegistry();
  assert.equal(registry.get('gmail.send_draft'), undefined);
  const mcp = createOperationMcpHandler(() => registry, () => caller);
  const read = async (extra: Record<string, unknown> = {}) => {
    const reply = await mcp({ name: 'gmail.read_thread', input: { connectionId: 'one', threadId: 'thread-one', limit: 1, ...extra } });
    const value = JSON.parse(reply.content[0].text);
    const text = JSON.stringify(value);
    assert(Buffer.byteLength(text) <= 65536);
    for (const forbidden of ['synthetic-access', 'synthetic-refresh', 'synthetic-proof-key', 'synthetic-sensitive-detail']) assert(!text.includes(forbidden));
    observations.push({ mode, value });
    return value;
  };
  let result = await read();
  assert.equal(result.ok, true); assert.equal(result.untrusted, true); assert.equal(result.items[0].subject, 'Fixture one');
  assert.equal(result.items[0].bodyParts, undefined); assert.equal(result.items[0].attachments, undefined);
  assert(requests.every((request) => request.format !== 'full' && !request.path.includes('/attachments/')));
  const firstCursor = result.nextCursor;
  assert.equal((await read({ cursor: firstCursor })).items[0].id, 'one-message-1');
  let before = requests.length;
  assert.equal((await read({ cursor: firstCursor, connectionId: 'two' })).reason, 'invalid_cursor'); assert.equal(requests.length, before);
  mode = 'changed'; assert.equal((await read({ cursor: firstCursor })).reason, 'thread_changed');
  mode = 'normal'; result = await read({ body: true, attachments: true });
  assert.equal(result.items[0].bodyParts[0].text, 'Hello 你好'); assert.equal(result.items[0].attachments[0].data, Buffer.from([0, 1, 255]).toString('base64url'));
  assert.equal((await read({ connectionId: 'two' })).items[0].subject, 'Fixture two');
  mode = 'latin'; assert.equal((await read({ body: true })).items[0].bodyParts[0].text, 'café');
  mode = 'body-limit'; result = await read({ body: true }); assert.equal(result.items[0].bodyParts[0].text.length, 4096); assert.equal(result.items[0].truncated, true);
  mode = 'attachment-limit'; before = requests.length; result = await read({ attachments: true });
  assert.equal(result.items[0].attachments[0].omitted, 'byte_limit'); assert.equal(result.items[0].truncated, true); assert.equal(requests.length - before, 2);
  mode = 'attachment-count'; before = requests.length; result = await read({ attachments: true });
  assert.equal(result.items[0].attachments.length, 2); assert.equal(requests.length - before, 4); assert.equal(result.items[0].truncated, true);
  mode = 'part-count'; result = await read({ body: true }); assert(result.items[0].bodyParts.length <= 32); assert.equal(result.items[0].truncated, true);
  mode = 'page-budget'; result = await read({ body: true, attachments: true, limit: 3 });
  assert.equal(result.items.length, 2); assert.equal(result.truncated, true);
  const last = await read({ body: true, attachments: true, limit: 3, cursor: result.nextCursor });
  assert.deepEqual([...result.items, ...last.items].map((item: { id: string }) => item.id), ['one-message-0', 'one-message-1', 'one-message-2']); assert.equal(last.nextCursor, undefined);
  mode = 'attachment-error'; assert.equal((await read({ attachments: true })).reason, 'rate_limited');
  before = requests.length; caller = { sessionId: '', role: 'universal_read' }; assert.equal((await read()).reason, 'session_required'); assert.equal(requests.length, before);
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  await vault.replace(rows[1], { accessToken: 'synthetic-access-two', expiresAt: Date.now() + 3600000, scopes: [] });
  assert.equal((await read({ connectionId: 'two' })).reason, 'missing_scope'); assert.equal(requests.length, before);
} finally {
  try { await app?.cleanup(); } finally { fake.stop(true); closed = true; writeFileSync(join(run, 'evidence/google-thread.json'), JSON.stringify({ runtime: process.versions, requests, observations, closed }, null, 2)); }
}
process.stdout.write('PASS: isolated daemon/MCP thread metadata, explicit bodies/attachments, paging, bounds and charset decoding; resources closed\n');
