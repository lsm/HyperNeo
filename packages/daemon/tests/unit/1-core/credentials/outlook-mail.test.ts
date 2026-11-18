import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
let db: Awaited<ReturnType<typeof createTestDb>>;
let mcp: ReturnType<typeof createOperationMcpHandler>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let fetchImpl: ReturnType<typeof vi.fn<Fetch>>;
let mode: string;
let nextLink: string | undefined;
let caller: { sessionId?: string; role?: 'neo' | 'universal_read' };
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
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
};
const message = (id: string) => ({
  id,
  conversationId: 'conversation-one',
  subject: `Subject ${id}`,
  receivedDateTime: '2026-11-18T12:00:00Z',
  bodyPreview: `Preview synthetic-access-token ${'p'.repeat(400)}`,
  from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } },
  toRecipients: [{ emailAddress: { name: 'One', address: 'one@example.test' } }],
});

beforeEach(async () => {
  db = await createTestDb();
  mode = 'normal';
  nextLink = `${graph}/v1.0/me/messages?$search=%22fixture%22&$top=2&$select=id,conversationId&$skiptoken=page-two`;
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  const vault = new ConnectionVault(
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
  fetchImpl = vi.fn<Fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(graph);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access-token');
    expect(init?.redirect).toBe('error');
    expect(init?.method ?? 'GET').toBe('GET');
    if (mode === 'rate') return new Response('synthetic-sensitive-error', { status: 429 });
    if (url.pathname === '/v1.0/me/messages') {
      expect(url.searchParams.get('$select')).not.toContain('body,');
      const filter = url.searchParams.get('$filter');
      if (filter) {
        expect(filter).toBe("conversationId eq 'conversation-one'");
        const ids =
          mode === 'wide' ? Array.from({ length: 10 }, (_, i) => `w${i}`) : ['m1', 'm2', 'm3'];
        return Response.json({ value: ids.map(message) });
      }
      const next = url.searchParams.get('$skiptoken');
      return Response.json({
        value: [message(next ? 'page-two' : 'page-one')],
        ...(next ? {} : { '@odata.nextLink': nextLink }),
      });
    }
    const id = url.pathname.split('/').at(-1)!;
    expect(new Headers(init?.headers).get('prefer')).toBe('outlook.body-content-type="text"');
    const content =
      mode === 'wide' ? '你'.repeat(5000) : id === 'm2' ? 'b'.repeat(80 * 1024) : `Body of ${id}`;
    return Response.json({ id, body: { contentType: 'text', content } });
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
const invoke = async (name: string, input: unknown = {}) =>
  JSON.parse((await mcp({ name, input })).content[0].text);
const search = (extra: Record<string, unknown> = {}) =>
  invoke('outlook.search', { connectionId: microsoft.id, query: 'fixture', limit: 2, ...extra });
const read = (extra: Record<string, unknown> = {}) =>
  invoke('outlook.read_thread', {
    connectionId: microsoft.id,
    conversationId: 'conversation-one',
    ...extra,
  });

test('microsoft.accounts lists only Microsoft connections to agent sessions', async () => {
  expect(await invoke('microsoft.accounts')).toEqual({
    connections: [
      { id: microsoft.id, email: microsoft.email, scopes: microsoft.scopes, health: 'healthy' },
    ],
  });
  caller = { role: 'universal_read' };
  expect(await invoke('microsoft.accounts')).toEqual({ ok: false, reason: 'session_required' });
});

test('outlook.search returns bounded, redacted headers and pages through an opaque cursor', async () => {
  const first = await search();
  expect(first).toMatchObject({ ok: true, untrusted: true, truncated: true });
  expect(first.items).toEqual([
    {
      id: 'page-one',
      conversationId: 'conversation-one',
      from: 'Sender <sender@example.test>',
      to: 'One <one@example.test>',
      subject: 'Subject page-one',
      receivedAt: '2026-11-18T12:00:00Z',
      preview: expect.any(String),
      truncated: true,
    },
  ]);
  expect(first.items[0].preview).toHaveLength(256);
  expect(first.items[0].preview).toContain('[redacted]');
  expect(JSON.stringify(first)).not.toContain('synthetic-access-token');
  expect(first.nextCursor).not.toContain('graph.microsoft.com');
  const listing = new URL(String(fetchImpl.mock.calls[0][0]));
  expect(listing.searchParams.get('$search')).toBe('"fixture"');
  expect(listing.searchParams.get('$top')).toBe('2');
  const second = await search({ cursor: first.nextCursor });
  expect(second.items[0].id).toBe('page-two');
  expect(second.nextCursor).toBeUndefined();
  const paged = new URL(String(fetchImpl.mock.calls[1][0]));
  expect(`${paged.origin}${paged.pathname}`).toBe(`${graph}/v1.0/me/messages`);
  expect(paged.searchParams.get('$skiptoken')).toBe('page-two');
});

test('cursors for another query, connection or operation and forged cursors send no request', async () => {
  const { nextCursor } = await search();
  const before = fetchImpl.mock.calls.length;
  for (const reply of [
    await search({ cursor: nextCursor, query: 'other' }),
    await search({ cursor: 'forged' }),
    await invoke('outlook.search', {
      connectionId: google.id,
      query: 'fixture',
      cursor: nextCursor,
    }),
    await read({ cursor: nextCursor }),
  ])
    expect(reply.ok).toBe(false);
  expect((await search({ cursor: 'forged' })).reason).toBe('invalid_cursor');
  expect(fetchImpl.mock.calls.length).toBe(before);
});

test('a next link on another origin or collection is refused instead of becoming a cursor', async () => {
  for (const link of [
    'https://attacker.example/v1.0/me/messages?$skiptoken=x',
    `${graph}/v1.0/me/mailFolders/inbox/messages?$skiptoken=x`,
    `${graph}/beta/me/messages?$skiptoken=x`,
    `${graph}/v1.0/me/messages?$expand=attachments&$skiptoken=x`,
  ]) {
    nextLink = link;
    expect(await search()).toEqual({ ok: false, reason: 'invalid_response' });
  }
});

test('Google connections, missing sessions and rate limits are refused', async () => {
  const before = fetchImpl.mock.calls.length;
  expect(await invoke('outlook.search', { connectionId: google.id, query: 'x' })).toEqual({
    ok: false,
    reason: 'unknown_connection',
  });
  caller = { role: 'universal_read' };
  expect((await search()).reason).toBe('session_required');
  expect(fetchImpl.mock.calls.length).toBe(before);
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  mode = 'rate';
  expect(await search()).toEqual({ ok: false, reason: 'rate_limited' });
});

test('outlook.read_thread lists the conversation without bodies by default', async () => {
  const thread = await read({ limit: 3 });
  expect(thread).toMatchObject({ ok: true, untrusted: true, conversationId: 'conversation-one' });
  expect(thread.items.map((item: { id: string }) => item.id)).toEqual(['m1', 'm2', 'm3']);
  expect(thread.items[0].body).toBeUndefined();
  expect(fetchImpl.mock.calls).toHaveLength(1);
});

test('a requested body over the cap returns that preview marked truncated and the other bodies', async () => {
  const thread = await read({ limit: 3, body: true });
  expect(thread.ok).toBe(true);
  const [one, two, three] = thread.items;
  expect(one.body).toBe('Body of m1');
  expect(three.body).toBe('Body of m3');
  expect(two.body).toBeUndefined();
  expect(two.truncated).toBe(true);
  expect(two.preview.length).toBeGreaterThan(0);
});

test('a hand-made cursor cannot change the Graph path the token is sent to', async () => {
  const before = fetchImpl.mock.calls.length;
  for (const query of [
    '/../../users/other/messages?$top=1',
    '/../../../beta/me/events',
    '#x',
    '?$top=1&$select=id,body',
  ]) {
    const cursor = Buffer.from(
      JSON.stringify({
        connectionId: microsoft.id,
        operation: 'outlook.search',
        key: createHash('sha256').update('fixture').digest('hex'),
        query,
      })
    ).toString('base64url');
    expect(await search({ cursor })).toEqual({ ok: false, reason: 'invalid_cursor' });
  }
  expect(fetchImpl.mock.calls.length).toBe(before);
});

test('long multibyte bodies drop bodies to fit instead of failing the page', async () => {
  mode = 'wide';
  const thread = await read({ limit: 10, body: true });
  expect(thread.ok).toBe(true);
  expect(thread.items).toHaveLength(10);
  expect(thread.truncated).toBe(true);
  expect(thread.items[0].body.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(thread))).toBeLessThanOrEqual(65536);
});
