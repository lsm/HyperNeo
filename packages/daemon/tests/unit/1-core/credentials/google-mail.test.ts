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
let mode: string, rawDraft: string, method: string, path: string;
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
  rawDraft = '';
  method = '';
  path = '';
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
    method = init?.method ?? 'GET';
    path = url.pathname;
    expect(path).not.toMatch(/\/send$/);
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
    expect(
      path === '/gmail/v1/users/me/drafts' || path === '/gmail/v1/users/me/drafts/draft-one'
    ).toBe(true);
    expect(method === 'POST' || method === 'PUT').toBe(true);
    const data = JSON.parse(init?.body as string);
    rawDraft = Buffer.from(data.message.raw, 'base64url').toString('utf8');
    return Response.json({
      id: 'draft-one',
      message: { id: method === 'POST' ? 'message-one' : 'message-two', threadId: 'thread-one' },
    });
  });
  mcp = createOperationMcpHandler(
    createOperationRegistry(
      createGoogleConnectionOperations(() => db.getDatabase(), {
        createStore: () => store,
        fetchImpl,
      })
    ),
    () => ({ sessionId: 'synthetic-worker', role: 'neo' })
  );
});
afterEach(() => db.close());
const invoke = async (name: string, input: unknown) =>
  JSON.parse((await mcp({ name, input })).content[0].text);
const read = (extra: Record<string, unknown> = {}) =>
  invoke('gmail.read_thread', { connectionId: 'one', threadId: 'thread-one', limit: 1, ...extra });
const draft = (extra: Record<string, unknown> = {}) =>
  invoke('gmail.draft', {
    connectionId: 'one',
    to: ['recipient@example.test'],
    subject: 'Hello 你好',
    text: body,
    ...extra,
  });

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

test('draft creation uses the verified sender, MIME encoding and never sends', async () => {
  const result = await draft({
    attachments: [
      {
        filename: 'fixture.bin',
        mimeType: 'application/octet-stream',
        data: Buffer.from([0, 1, 255]).toString('base64url'),
      },
    ],
  });
  expect(result).toMatchObject({ ok: true, draftId: 'draft-one', messageId: 'message-one' });
  expect(method).toBe('POST');
  expect(path).toBe('/gmail/v1/users/me/drafts');
  expect(rawDraft).toContain('From: one@example.test\r\n');
  expect(rawDraft).toContain('To: recipient@example.test\r\n');
  expect(rawDraft).toContain(Buffer.from(body).toString('base64'));
  expect(rawDraft).toContain('AAH/');
});

test('updating names the existing draft and replaces its MIME message', async () => {
  expect(await draft({ draftId: 'draft-one', text: 'Changed body' })).toMatchObject({
    ok: true,
    draftId: 'draft-one',
    messageId: 'message-two',
  });
  expect(method).toBe('PUT');
  expect(path).toBe('/gmail/v1/users/me/drafts/draft-one');
  expect(rawDraft).toContain(Buffer.from('Changed body').toString('base64'));
});

test.each([
  { draftId: '../messages/send' },
  { to: ['user@example.test\r\nBcc:other@example.test'] },
  { subject: 'header\r\nBcc:other@example.test' },
  { send: true },
  { attachments: [{ filename: 'x', mimeType: 'text/plain', data: 'bad%%%' }] },
])('invalid drafts fail before writes: %j', async (extra) => {
  expect((await draft(extra)).code).toBe('invalid_input');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('missing compose scope refuses draft creation and no send operation exists', async () => {
  await vault.replace(row, {
    accessToken: 'synthetic-access',
    expiresAt: Date.now() + 3600000,
    scopes: [row.scopes[0]],
  });
  expect((await draft()).reason).toBe('missing_scope');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(
    (await invoke('gmail.send_draft', { connectionId: 'one', draftId: 'draft-one' })).code
  ).toBe('unknown_operation');
});
