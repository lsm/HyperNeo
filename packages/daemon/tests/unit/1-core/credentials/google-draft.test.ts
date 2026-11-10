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
const draft = (extra: Record<string, unknown> = {}) =>
  invoke('gmail.draft', {
    connectionId: 'one',
    to: ['recipient@example.test'],
    subject: 'Hello 你好',
    text: body,
    ...extra,
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
