import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../../src/storage/repositories/google-connections-worker.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let mcp: ReturnType<typeof createOperationMcpHandler>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let mode: string;
let caller: { sessionId?: string; role?: 'neo' | 'universal_read' };
let vault: ConnectionVault;
const row = {
  id: 'one',
  provider: 'google' as const,
  accountId: 'synthetic-subject',
  email: 'one@example.test',
  health: 'healthy' as const,
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
  ],
};
const body = 'Hello 你好';
const encoded = (value: string) => Buffer.from(value).toString('base64url');
const message = (id: string, full: boolean) => ({
  id,
  threadId: 'thread-one',
  snippet: 'Preview',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'Subject', value: 'Fixture' },
      { name: 'From', value: 'sender@example.test' },
      { name: 'To', value: 'one@example.test' },
    ],
    ...(full
      ? {
          parts: [
            {
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }],
              body: {
                data: encoded(mode === 'long' ? 'x'.repeat(10000) : body),
                size: body.length,
              },
            },
            {
              mimeType: 'application/octet-stream',
              filename: 'fixture.bin',
              body: {
                attachmentId: 'attachment-one',
                size: mode === 'large-attachment' ? 100000 : 3,
              },
            },
          ],
        }
      : {}),
  },
});

beforeEach(async () => {
  db = await createTestDb();
  mode = 'normal';
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  vault = new ConnectionVault(
    store,
    await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-instance')
  );
  await db.gateway.call(googleConnectionWrites, 'put', row);
  await vault.replace(row, {
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3600000,
    scopes: row.scopes,
    client: { clientId: 'synthetic-client' },
  });
  fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://gmail.googleapis.com');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access');
    expect(init?.redirect).toBe('error');
    const path = url.pathname;
    expect(init?.method ?? 'GET').toBe('GET');
    if (path.endsWith('/threads/thread-one')) {
      expect(url.searchParams.get('format')).toBe('minimal');
      return Response.json({
        id: 'thread-one',
        historyId: mode === 'changed' ? 'revision-two' : 'revision-one',
        messages: Array.from({ length: 3 }, (_, i) => ({ id: `message-${i}` })),
      });
    }
    if (path.includes('/attachments/'))
      return Response.json({ size: 3, data: Buffer.from([0, 1, 255]).toString('base64url') });
    if (path.includes('/messages/'))
      return Response.json(
        message(path.split('/').at(-1)!, url.searchParams.get('format') === 'full')
      );
    throw new Error('Unexpected Google request');
  });
  mcp = createOperationMcpHandler(
    createOperationRegistry(
      createGoogleConnectionOperations(() => db.getDatabase(), {
        createStore: () => store,
        fetchImpl,
      })
    ),
    () => caller
  );
});
afterEach(() => db.close());
const invoke = async (name: string, input: unknown) =>
  JSON.parse((await mcp({ name, input })).content[0].text);
const read = (extra: Record<string, unknown> = {}) =>
  invoke('gmail.read_thread', { connectionId: 'one', threadId: 'thread-one', limit: 1, ...extra });
test('thread metadata is paged without requesting or returning bodies or attachments', async () => {
  const first = await read();
  expect(first).toMatchObject({
    ok: true,
    untrusted: true,
    truncated: true,
    items: [{ id: 'message-0' }],
  });
  expect(JSON.stringify(first)).not.toContain(body);
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/attachments/'))).toBe(false);
  const next = await read({ cursor: first.nextCursor });
  expect(next.items[0].id).toBe('message-1');
  expect(next.nextCursor).not.toBe(first.nextCursor);
});

test('explicit body and attachment requests decode text and preserve bounded binary data', async () => {
  const result = await read({ body: true, attachments: true });
  expect(result.items[0].bodyParts).toMatchObject([{ mimeType: 'text/plain', text: body }]);
  expect(result.items[0].attachments).toMatchObject([
    { filename: 'fixture.bin', data: Buffer.from([0, 1, 255]).toString('base64url') },
  ]);
});

test('oversized bodies and attachments report truncation without fetching oversized attachments', async () => {
  mode = 'long';
  expect((await read({ body: true })).items[0].bodyParts[0].text.length).toBe(4096);
  mode = 'large-attachment';
  fetchImpl.mockClear();
  const result = await read({ attachments: true });
  expect(result.truncated).toBe(true);
  expect(result.items[0].attachments[0]).toMatchObject({ omitted: 'byte_limit' });
  expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('/attachments/'))).toBe(false);
});

test('cursors cannot cross accounts or silently page a changed thread', async () => {
  const result = await read();
  fetchImpl.mockClear();
  expect((await read({ cursor: result.nextCursor, connectionId: 'two' })).reason).toBe(
    'invalid_cursor'
  );
  expect(fetchImpl).not.toHaveBeenCalled();
  mode = 'changed';
  expect((await read({ cursor: result.nextCursor })).reason).toBe('thread_changed');
});

test('thread reads require an eligible session and a granted read scope before network access', async () => {
  caller = {};
  expect((await read()).reason).toBe('session_required');
  caller = { sessionId: 'synthetic-worker', role: 'neo' };
  await vault.replace(row, {
    accessToken: 'synthetic-access',
    expiresAt: Date.now() + 3600000,
    scopes: [],
  });
  expect((await read()).reason).toBe('missing_scope');
  expect(fetchImpl).not.toHaveBeenCalled();
});
