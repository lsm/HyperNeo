import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createMicrosoftConnectionOperations } from '../../../../src/lib/connections/microsoft-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../../src/storage/repositories/google-connections-worker.ts';

const graph = 'https://graph.microsoft.com';
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sent = { method: string; path: string; query: string; body: unknown };
let db: Awaited<ReturnType<typeof createTestDb>>;
let mcp: ReturnType<typeof createOperationMcpHandler>;
let sent: Sent[];
let mode: string;
let caller: { sessionId?: string; role?: 'neo' | 'universal_read' };
let vault: ConnectionVault;
const microsoft = {
  id: 'outlook-one',
  provider: 'microsoft' as const,
  accountId: '11111111-2222-4333-8444-555555555555.synthetic-object',
  email: 'one@example.test',
  health: 'healthy' as const,
  scopes: ['openid', 'profile', 'email', 'offline_access', 'Mail.ReadWrite', 'Calendars.Read'],
};
const google = {
  id: 'gmail-one',
  provider: 'google' as const,
  accountId: 'synthetic-subject',
  email: 'g@example.test',
  health: 'healthy' as const,
  scopes: ['https://www.googleapis.com/auth/gmail.compose'],
};

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  mode = 'normal';
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  vault = new ConnectionVault(
    store,
    await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-instance')
  );
  for (const row of [microsoft, google]) {
    await db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, {
      accessToken: 'synthetic-access-token',
      refreshToken: 'synthetic-refresh-token',
      expiresAt: Date.now() + 3600000,
      scopes: row.scopes,
      client: { clientId: 'synthetic-client' },
    });
  }
  const fetchImpl = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(graph);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access-token');
    expect(init?.redirect).toBe('error');
    const method = init?.method ?? 'GET';
    sent.push({
      method,
      path: url.pathname,
      query: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (mode === 'down') return new Response('synthetic-sensitive-error', { status: 503 });
    if (method === 'POST') return Response.json({ id: 'draft-new', isDraft: true, subject: 'x' });
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    if (method === 'GET') return Response.json({ id, isDraft: id !== 'sent-one' });
    return Response.json({ id: mode === 'other-id' ? 'someone-else' : id, isDraft: true });
  });
  mcp = createOperationMcpHandler(
    createOperationRegistry(
      createMicrosoftConnectionOperations(() => db.getDatabase(), {
        createStore: () => store,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ),
    () => caller
  );
});
afterEach(() => db.close());

const draft = async (extra: Record<string, unknown> = {}) =>
  JSON.parse(
    (
      await mcp({
        name: 'outlook.draft',
        input: {
          connectionId: microsoft.id,
          to: ['to@example.test'],
          cc: ['cc@example.test'],
          subject: 'Synthetic subject',
          text: 'Synthetic body',
          ...extra,
        },
      })
    ).content[0].text
  );
const noSends = () =>
  expect(
    sent.filter(
      (request) =>
        request.method === 'DELETE' || /\/(send|move|copy|reply|forward)/i.test(request.path)
    )
  ).toEqual([]);

test('creates a text draft in Drafts and returns its id', async () => {
  expect(await draft()).toEqual({ ok: true, draftId: 'draft-new' });
  expect(sent).toEqual([
    {
      method: 'POST',
      path: '/v1.0/me/messages',
      query: '',
      body: {
        subject: 'Synthetic subject',
        body: { contentType: 'Text', content: 'Synthetic body' },
        toRecipients: [{ emailAddress: { address: 'to@example.test' } }],
        ccRecipients: [{ emailAddress: { address: 'cc@example.test' } }],
        bccRecipients: [],
      },
    },
  ]);
  noSends();
});

test('updates an existing draft after confirming it is still a draft', async () => {
  expect(await draft({ draftId: 'AAMk-draft=', subject: 'Changed' })).toEqual({
    ok: true,
    draftId: 'AAMk-draft=',
  });
  expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
    'GET /v1.0/me/messages/AAMk-draft%3D',
    'PATCH /v1.0/me/messages/AAMk-draft%3D',
  ]);
  expect(new URLSearchParams(sent[0].query).get('$select')).toBe('id,isDraft');
  expect((sent[1].body as { subject: string }).subject).toBe('Changed');
  noSends();
});

test('refuses to update a message that is not a draft and sends no change', async () => {
  expect(await draft({ draftId: 'sent-one' })).toEqual({ ok: false, reason: 'not_a_draft' });
  expect(sent.map((request) => request.method)).toEqual(['GET']);
  noSends();
});

test('a reply naming another message reports an unknown outcome', async () => {
  mode = 'other-id';
  expect(await draft({ draftId: 'draft-one' })).toEqual({
    ok: false,
    reason: 'draft_outcome_unknown',
  });
});

test('a failed write reports an unknown outcome without Graph error text', async () => {
  mode = 'down';
  expect(await draft()).toEqual({ ok: false, reason: 'draft_outcome_unknown' });
});

test('a Google connection or a caller without a session sends nothing', async () => {
  expect(await draft({ connectionId: google.id })).toEqual({
    ok: false,
    reason: 'unknown_connection',
  });
  caller = { sessionId: '', role: 'universal_read' };
  expect((await draft()).reason).toBe('session_required');
  expect(sent).toEqual([]);
});

test('a draft id cannot reach another Graph path', async () => {
  await draft({ draftId: 'draft-one/send' });
  expect(sent.map((request) => request.path)).toEqual([
    '/v1.0/me/messages/draft-one%2Fsend',
    '/v1.0/me/messages/draft-one%2Fsend',
  ]);
  noSends();
});

test('a grant stored with fully qualified Graph scopes can write drafts', async () => {
  await vault.replace(microsoft, {
    accessToken: 'synthetic-access-token',
    refreshToken: 'synthetic-refresh-token',
    expiresAt: Date.now() + 3600000,
    scopes: ['openid', 'https://graph.microsoft.com/Mail.ReadWrite'],
    client: { clientId: 'synthetic-client' },
  });
  expect(await draft()).toEqual({ ok: true, draftId: 'draft-new' });
});
