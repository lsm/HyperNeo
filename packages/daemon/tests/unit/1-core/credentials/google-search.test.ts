import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import type { CallerIdentity } from '../../../../src/lib/operations/caller.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import { googleConnectionWrites } from '../../../../src/storage/repositories/google-connections-worker.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let handler: ReturnType<typeof createOperationMcpHandler>;
let caller: CallerIdentity;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let mode: string;
let apiCalls: string[], refreshes: number;
let vault: ConnectionVault;
const rows = ['one', 'two'].map((id) => ({
  id,
  provider: 'google' as const,
  accountId: `subject-${id}`,
  email: `${id}@example.test`,
  health: 'healthy' as const,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
}));

beforeEach(async () => {
  db = await createTestDb();
  mode = 'normal';
  apiCalls = [];
  refreshes = 0;
  const store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  const identity = await db.gateway.call(
    artifactIdentityWrites,
    'ensure',
    'synthetic-google-client'
  );
  vault = new ConnectionVault(store, identity);
  for (const row of rows) {
    await db.gateway.call(googleConnectionWrites, 'put', row);
    await vault.replace(row, {
      accessToken: `synthetic-access-${row.id}`,
      refreshToken: `synthetic-refresh-${row.id}`,
      expiresAt: Date.now() + 3600000,
      scopes: row.scopes,
      client: { clientId: 'synthetic-client' },
    });
  }
  fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.hostname === 'oauth2.googleapis.com') {
      refreshes++;
      return Response.json({
        access_token: 'synthetic-renewed-access',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    expect(target.origin).toBe('https://gmail.googleapis.com');
    expect(init?.redirect).toBe('error');
    const bearer = new Headers(init?.headers).get('authorization')!;
    apiCalls.push(bearer);
    if (mode === 'timeout')
      return new Promise((_done, fail) =>
        init!.signal!.addEventListener('abort', () => fail(init!.signal!.reason), { once: true })
      );
    if (mode === 'rate')
      return new Response('synthetic-access-one', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    if (
      mode === 'always-unauthorized' ||
      (mode === 'unauthorized' && bearer !== 'Bearer synthetic-renewed-access')
    )
      return new Response('synthetic-sensitive-description', { status: 401 });
    if (mode === 'oversized') return new Response('x'.repeat(65537));
    if (target.pathname.endsWith('/messages')) {
      expect(target.searchParams.get('q')).toBe('subject:fixture');
      expect(Number(target.searchParams.get('maxResults'))).toBeLessThanOrEqual(10);
      return Response.json({
        messages: [{ id: 'a1', threadId: 'b1' }],
        nextPageToken: 'opaque-synthetic-next',
        echo: bearer,
      });
    }
    expect(target.searchParams.get('format')).toBe('metadata');
    return Response.json({
      id: 'a1',
      threadId: 'b1',
      snippet: `Untrusted mail ${bearer} ${'x'.repeat(1000)}`,
      payload: {
        headers: [
          { name: 'Subject', value: 'Fixture subject' },
          { name: 'From', value: 'sender@example.test' },
          { name: 'Date', value: 'Synthetic date' },
        ],
        body: { data: 'synthetic-full-body-must-not-leak' },
      },
    });
  });
  caller = { sessionId: 'synthetic-owned-session', role: 'neo' };
  const registry = createOperationRegistry(
    createGoogleConnectionOperations(() => db.getDatabase(), {
      createStore: () => store,
      fetchImpl,
      ...{ apiTimeoutMs: 40 },
    })
  );
  handler = createOperationMcpHandler(registry, () => caller);
});
afterEach(() => db.close());
async function invoke(
  name = 'gmail.search',
  input: unknown = { connectionId: 'one', query: 'subject:fixture', limit: 10 }
) {
  const reply = await handler({ name, input });
  return JSON.parse(reply.content[0].text);
}

test('eligible sessions discover account ids without credential or subject data', async () => {
  const result = await invoke('google.accounts', {});
  expect(result.connections.map((row: { id: string }) => row.id)).toEqual(['one', 'two']);
  expect(JSON.stringify(result)).not.toContain('subject-one');
  expect(JSON.stringify(result)).not.toContain('synthetic-access');
});

test('Gmail search returns bounded projected metadata through the real MCP adapter', async () => {
  const result = await invoke();
  expect(result).toMatchObject({
    ok: true,
    nextCursor: 'opaque-synthetic-next',
    items: [{ id: 'a1', threadId: 'b1', subject: 'Fixture subject', from: 'sender@example.test' }],
    truncated: true,
  });
  expect(JSON.stringify(result)).not.toContain('synthetic-access-one');
  expect(JSON.stringify(result)).not.toContain('synthetic-full-body');
  expect(JSON.stringify(result)).not.toContain('synthetic-refresh');
  expect(apiCalls).toEqual(['Bearer synthetic-access-one', 'Bearer synthetic-access-one']);
});

test('account routing never borrows a different connected account', async () => {
  expect((await invoke('gmail.search', { connectionId: 'two', query: 'subject:fixture' })).ok).toBe(
    true
  );
  expect(apiCalls.every((value) => value === 'Bearer synthetic-access-two')).toBe(true);
  expect(
    await invoke('gmail.search', { connectionId: 'foreign', query: 'subject:fixture' })
  ).toMatchObject({ ok: false, reason: 'unknown_connection' });
  expect(apiCalls).toHaveLength(2);
});

test('unknown session callers cannot discover or search connected accounts', async () => {
  caller = { role: 'universal_read' };
  expect(await invoke('google.accounts', {})).toMatchObject({
    ok: false,
    reason: 'session_required',
  });
  expect(await invoke()).toMatchObject({ ok: false, reason: 'session_required' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('missing Gmail scope disables search before network access', async () => {
  const tokens = await vault.read(rows[0]);
  await vault.replace(rows[0], { ...tokens!, scopes: [] });
  expect(await invoke()).toMatchObject({ ok: false, reason: 'missing_scope' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a 401 forces one refresh of a still-fresh grant before retrying', async () => {
  mode = 'unauthorized';
  expect((await invoke()).ok).toBe(true);
  expect(refreshes).toBe(1);
  expect(apiCalls[0]).toBe('Bearer synthetic-access-one');
  expect(apiCalls.slice(1).every((value) => value === 'Bearer synthetic-renewed-access')).toBe(
    true
  );
});

test('a second 401 fails clearly without looping or exposing error bodies', async () => {
  mode = 'always-unauthorized';
  const result = await invoke();
  expect(result).toMatchObject({ ok: false, reason: 'unauthorized' });
  expect(apiCalls).toHaveLength(2);
  expect(refreshes).toBe(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-sensitive');
});

test.each([
  ['rate', 'rate_limited'],
  ['timeout', 'timeout'],
  ['oversized', 'invalid_response'],
])('bounded %s failures expose no credential details', async (kind, reason) => {
  mode = kind;
  const result = await invoke();
  expect(result).toMatchObject({ ok: false, reason });
  expect(apiCalls).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('synthetic-access');
});

test.each([
  { limit: 0 },
  { limit: 11 },
  { limit: 1.5 },
  { cursor: 'x'.repeat(2049) },
  { query: 'x'.repeat(1001) },
  { connectionId: '' },
  { url: 'https://example.invalid' },
])('search refuses unsupported input before fetching: %j', async (extra) => {
  const result = await invoke('gmail.search', {
    connectionId: 'one',
    query: 'subject:fixture',
    ...extra,
  });
  expect(result.code).toBe('invalid_input');
  expect(fetchImpl).not.toHaveBeenCalled();
});
