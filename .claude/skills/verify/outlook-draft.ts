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
  { id: 'gmail-one', provider: 'google' as const, accountId: 'synthetic-subject', email: 'g@example.test', scopes: ['https://www.googleapis.com/auth/gmail.compose'], health: 'healthy' as const },
];
const mailbox = new Map<string, { isDraft: boolean; subject: string }>([['received-one', { isDraft: false, subject: 'Received' }]]);
const requests: { method: string; path: string; query: string }[] = [];
const observations: unknown[] = [];
const fake = await createHttpWsServer({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
  const url = new URL(request.url);
  assert.equal(request.headers.get('authorization'), 'Bearer synthetic-access-token');
  requests.push({ method: request.method, path: url.pathname, query: url.search });
  const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
  if (request.method === 'POST' && url.pathname === '/v1.0/me/messages') {
    const body = await request.json();
    const created = `draft-${mailbox.size}`;
    mailbox.set(created, { isDraft: true, subject: body.subject });
    return Response.json({ id: created, isDraft: true, subject: body.subject });
  }
  const message = mailbox.get(id);
  if (!message) return new Response('missing', { status: 404 });
  if (request.method === 'GET') return Response.json({ id, isDraft: message.isDraft });
  if (request.method === 'PATCH') {
    message.subject = (await request.json()).subject;
    return Response.json({ id, isDraft: message.isDraft, subject: message.subject });
  }
  return new Response('refused', { status: 405 });
} });
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
  const mcp = createOperationMcpHandler(() => app!.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-worker', role: 'neo' as const }));
  const draft = async (input: Record<string, unknown>) => {
    const full = { connectionId: 'outlook-one', to: ['to@example.test'], subject: 'First', text: 'Synthetic body', ...input };
    const value = JSON.parse((await mcp({ name: 'outlook.draft', input: full })).content[0].text);
    observations.push({ input: full, value });
    for (const forbidden of ['synthetic-access-token', 'synthetic-refresh-token', 'synthetic-proof-key', 'graph.microsoft.com']) assert(!JSON.stringify(value).includes(forbidden), `leaked: ${forbidden}`);
    return value;
  };

  const created = await draft({});
  assert.equal(created.ok, true);
  assert.equal(mailbox.get(created.draftId)?.subject, 'First');
  const updated = await draft({ draftId: created.draftId, subject: 'Second' });
  assert.deepEqual(updated, { ok: true, draftId: created.draftId });
  assert.equal(mailbox.get(created.draftId)?.subject, 'Second');
  const before = requests.length;
  assert.deepEqual(await draft({ draftId: 'received-one', subject: 'Overwrite' }), { ok: false, reason: 'not_a_draft' });
  assert.deepEqual(requests.slice(before).map((row) => row.method), ['GET']);
  assert.equal(mailbox.get('received-one')?.subject, 'Received');
  const google = requests.length;
  assert.deepEqual(await draft({ connectionId: 'gmail-one' }), { ok: false, reason: 'unknown_connection' });
  assert.equal(requests.length, google, 'a Google connection sent no Graph request');
  const sends = requests.filter((row) => row.method === 'DELETE' || /\/(send|move|copy|reply|forward)/i.test(row.path));
  assert.deepEqual(sends, [], 'zero send, move or delete requests');
} finally {
  await app?.cleanup();
  fake.stop(true);
  writeFileSync(join(run, 'evidence/outlook-draft.json'), JSON.stringify({ runtime: process.versions, requests, observations, mailbox: [...mailbox] }, null, 2));
}
process.stdout.write('PASS: Outlook draft create, update, non-draft refusal and zero sends through the real daemon operations MCP; resources closed\n');
