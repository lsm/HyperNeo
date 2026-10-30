import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'];
const rows = ['one', 'two'].map((id) => ({ id, provider: 'google' as const, accountId: `synthetic-subject-${id}`, email: `${id}@example.test`, scopes, health: 'healthy' as const }));
type Parsed = { from: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; attachments: { filename: string; mimeType: string; data: string }[]; defects: string[] };
type Draft = { id: string; messageId: string; threadId: string; account: string; parsed: Parsed };
const drafts = new Map<string, Draft>();
const requests: { mode: string; account: string; path: string; method: string }[] = [];
const observations: unknown[] = [], parsedMessages: Parsed[] = [];
let mode = 'normal', writes = 0, refreshes = 0, closed = false, rejectedRaw = ''; 
const parser = `import sys,json,base64
from email import policy
from email.parser import BytesParser
m=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read())
def addresses(name):
 return [a.addr_spec for a in m[name].addresses] if m[name] else []
p=m.get_body(preferencelist=('plain',))
print(json.dumps(dict(from_=str(m['From']),to=addresses('To'),cc=addresses('Cc'),bcc=addresses('Bcc'),subject=str(m['Subject']),text=p.get_content() if p else '',attachments=[dict(filename=a.get_filename(),mimeType=a.get_content_type(),data=base64.urlsafe_b64encode(a.get_payload(decode=True)).rstrip(b'=').decode()) for a in m.iter_attachments()],defects=[str(d) for p in m.walk() for d in p.defects]),ensure_ascii=False))`;
function parseMime(raw: string): Parsed {
  const mime = Buffer.from(raw, 'base64url');
  assert.equal(mime.toString('base64url'), raw);
  for (const line of mime.toString('utf8').split('\r\n')) assert(Buffer.byteLength(line) <= 998);
  const result = spawnSync('python3', ['-I', '-c', parser], { input: mime, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const parsed = JSON.parse(result.stdout);
  parsed.from = parsed.from_; delete parsed.from_;
  assert.deepEqual(parsed.defects, []);
  writeFileSync(join(run, `evidence/draft-${parsedMessages.length + 1}.eml`), mime);
  parsedMessages.push(parsed);
  return parsed;
}
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/token') {
    assert.equal(request.method, 'POST');
    const form = new URLSearchParams(await request.text());
    const account = rows.find((row) => form.get('refresh_token') === `synthetic-refresh-${row.id}`)?.id;
    assert(account); refreshes++;
    return Response.json({ access_token: `synthetic-renewed-${account}`, expires_in: 3600, token_type: 'Bearer' });
  }
  const token = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
  const account = rows.find((row) => [`synthetic-access-${row.id}`, `synthetic-renewed-${row.id}`].includes(token))?.id;
  assert(account);
  requests.push({ mode, account, path: url.pathname, method: request.method });
  assert(!url.pathname.endsWith('/send'), 'send endpoint is forbidden');
  if (request.method === 'GET') {
    if (url.pathname.includes('/threads/')) {
      const draft = [...drafts.values()].find((draft) => draft.account === account && draft.threadId === url.pathname.split('/').at(-1));
      assert(draft); return Response.json({ id: draft.threadId, historyId: draft.messageId, messages: [{ id: draft.messageId }] });
    }
    const draft = [...drafts.values()].find((draft) => draft.account === account && draft.messageId === url.pathname.split('/').at(-1));
    assert(draft);
    const parsed = draft.parsed;
    return Response.json({ id: draft.messageId, threadId: draft.threadId, snippet: 'Draft preview', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: parsed.from }, { name: 'To', value: parsed.to.join(', ') }, { name: 'Subject', value: parsed.subject }], parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { size: Buffer.byteLength(parsed.text), data: Buffer.from(parsed.text).toString('base64url') } }, ...parsed.attachments.map((file) => ({ mimeType: file.mimeType, filename: file.filename, body: { size: Buffer.from(file.data, 'base64url').length, data: file.data } }))] } });
  }
  assert(request.method === 'POST' || request.method === 'PUT');
  assert(request.method === 'POST' ? url.pathname === '/gmail/v1/users/me/drafts' : /^\/gmail\/v1\/users\/me\/drafts\/[A-Za-z0-9_-]+$/.test(url.pathname));
  assert(request.headers.get('content-type')?.startsWith('application/json'));
  const payload = await request.json() as { message: { raw: string } };
  if (mode === 'unauthorized' && token.startsWith('synthetic-access-')) { rejectedRaw = payload.message.raw; return new Response('synthetic-sensitive-detail', { status: 401 }); }
  if (mode === 'unauthorized') assert.equal(payload.message.raw, rejectedRaw, '401 retry must preserve the exact prepared MIME');
  const parsed = parseMime(payload.message.raw);
  assert.equal(parsed.from, `${account}@example.test`);
  writes++;
  const id = request.method === 'POST' ? `draft-${account}-${writes}` : url.pathname.split('/').at(-1)!;
  if (request.method === 'PUT') assert(drafts.has(`${account}/${id}`), 'cannot update another account’s draft');
  const draft = { id, account, messageId: `message-${writes}`, threadId: `thread-${id}`, parsed };
  drafts.set(`${account}/${id}`, draft);
  if (mode === 'uncertain') return new Response('synthetic-sensitive-detail', { status: 503 });
  return Response.json({ id, message: { id: draft.messageId, threadId: draft.threadId } });
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
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false, googleConnections: { createStore, fetchImpl, schedule: () => () => {} } });
  assert.notEqual(app.server.port, 8399); await app.jobProcessor.stop();
  const vault = new ConnectionVault(createStore(app.db.getDatabase()), await app.db.gateway.call(artifactIdentityWrites, 'ensure', crypto.randomUUID()));
  for (const row of rows) {
    await app.db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, { accessToken: `synthetic-access-${row.id}`, refreshToken: `synthetic-refresh-${row.id}`, expiresAt: Date.now() + 3600000, scopes, client: { clientId: 'synthetic-client' } });
  }
  let caller = { sessionId: 'synthetic-worker', role: 'neo' as 'neo' | 'universal_read' };
  const registry = app.sessionManager.getOperationRegistry();
  assert.equal(registry.get('gmail.send_draft'), undefined); assert.equal(registry.get('google.http'), undefined);
  const mcp = createOperationMcpHandler(() => registry, () => caller);
  const invoke = async (name: string, input: unknown) => {
    const value = JSON.parse((await mcp({ name, input })).content[0].text);
    const text = JSON.stringify(value);
    for (const forbidden of ['synthetic-access', 'synthetic-renewed', 'synthetic-refresh', 'synthetic-proof-key', 'synthetic-sensitive-detail']) assert(!text.includes(forbidden));
    observations.push({ mode, name, value }); return value;
  };
  const input = { connectionId: 'one', to: ['first@example.test', 'second@example.test'], cc: ['copy@example.test'], bcc: ['hidden@example.test'], subject: `Subject ${'你好😃'.repeat(30)}`, text: 'First line\n你好', attachments: [{ filename: "note-你好'.bin", mimeType: 'application/octet-stream', data: Buffer.from([0, 1, 255]).toString('base64url') }] };
  const create = await invoke('gmail.draft', input);
  assert.equal(create.ok, true); assert.equal(writes, 1);
  assert.deepEqual(parsedMessages[0], { from: 'one@example.test', to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, attachments: input.attachments, defects: [] });
  let read = await invoke('gmail.read_thread', { connectionId: 'one', threadId: create.threadId, body: true, attachments: true });
  assert.equal(read.items[0].to, input.to.join(', ')); assert.equal(read.items[0].bodyParts[0].text, input.text); assert.deepEqual(read.items[0].attachments[0].data, input.attachments[0].data);
  const changed = { ...input, draftId: create.draftId, text: 'Changed body', attachments: [] };
  const updated = await invoke('gmail.draft', changed);
  assert.equal(updated.draftId, create.draftId); assert.notEqual(updated.messageId, create.messageId); assert.equal(writes, 2);
  read = await invoke('gmail.read_thread', { connectionId: 'one', threadId: updated.threadId, body: true }); assert.equal(read.items[0].bodyParts[0].text, changed.text);
  assert.equal((await invoke('gmail.draft', { ...input, connectionId: 'two' })).ok, true); assert.equal(parsedMessages.at(-1)!.from, 'two@example.test');
  let before = requests.length;
  for (const extra of [{ send: true }, { from: 'other@example.test' }, { draftId: '../messages/send' }, { subject: 'Subject\r\nBcc: injected@example.test' }]) assert.equal((await invoke('gmail.draft', { ...input, ...extra })).code, 'invalid_input');
  assert.equal((await invoke('gmail.draft', { ...input, connectionId: 'foreign' })).reason, 'unknown_connection'); assert.equal(requests.length, before);
  caller = { sessionId: '', role: 'universal_read' }; assert.equal((await invoke('gmail.draft', input)).reason, 'session_required'); assert.equal(requests.length, before);
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  mode = 'unauthorized'; before = writes;
  assert.equal((await invoke('gmail.draft', input)).ok, true); assert.equal(writes - before, 1); assert.equal(refreshes, 1);
  assert.equal(requests.filter((request) => request.mode === mode).length, 2); assert(requests.filter((request) => request.mode === mode).every((request) => request.method === 'POST'));
  mode = 'uncertain'; before = requests.length;
  assert.equal((await invoke('gmail.draft', input)).reason, 'draft_outcome_unknown'); assert.equal(requests.length - before, 1);
  await vault.replace(rows[1], { accessToken: 'synthetic-access-two', expiresAt: Date.now() + 3600000, scopes: [scopes[0]] }); before = requests.length;
  assert.equal((await invoke('gmail.draft', { ...input, connectionId: 'two' })).reason, 'missing_scope'); assert.equal(requests.length, before);
  assert(requests.filter((request) => request.method !== 'GET').every((request) => request.path === '/gmail/v1/users/me/drafts' || /^\/gmail\/v1\/users\/me\/drafts\/draft-/.test(request.path)));
} finally {
  try { await app?.cleanup(); } finally { fake.stop(true); closed = true; writeFileSync(join(run, 'evidence/google-drafts.json'), JSON.stringify({ runtime: process.versions, requests, observations, parsedMessages, writes, refreshes, closed }, null, 2)); }
}
process.stdout.write('PASS: isolated daemon/MCP MIME drafts independently parsed, updated and read back; no sends, uncertain writes not replayed; resources closed\n');
