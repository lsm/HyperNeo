import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { createConnectionLifecycle } from '../../../../src/lib/connections/lifecycle.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import type { ConnectionStatus, ConnectionTokens } from '../../../../src/lib/connections/status.ts';
import { artifactIdentityWrites } from '../../../../src/storage/repositories/artifact-file-identity-write.ts';
import {
  googleConnectionReads,
  googleConnectionWrites,
} from '../../../../src/storage/repositories/google-connections-worker.ts';

const tenant = '11111111-2222-4333-8444-555555555555';
const tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const scopes = 'openid profile email offline_access Mail.ReadWrite Calendars.Read';
const connection: ConnectionStatus = {
  id: 'synthetic-microsoft',
  provider: 'microsoft',
  accountId: `${tenant}.synthetic-object`,
  email: 'one@example.test',
  scopes: ['Mail.ReadWrite', 'Calendars.Read'],
  health: 'healthy',
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let vault: ConnectionVault;
let closed: AbortController;
let now: number;
let lifecycle: ReturnType<typeof createConnectionLifecycle>;
let requests: { url: string; form: Record<string, string> }[];
let respond: (count: number) => Promise<Response>;

const read = () => db.gateway.call(googleConnectionReads, 'list');
const save = (row: ConnectionStatus) => db.gateway.call(googleConnectionWrites, 'put', row);
const fetchImpl = (async (url, init) => {
  requests.push({
    url: String(url),
    form: Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams)),
  });
  if (String(url) !== tokenUrl) return new Response('unexpected host', { status: 503 });
  return respond(requests.length);
}) as typeof fetch;
const make = () =>
  createConnectionLifecycle({
    provider: 'microsoft',
    read,
    save,
    vault,
    closed: closed.signal,
    fetchImpl,
    now: () => now,
    startLogin: async () => {
      throw new Error('Login is not part of this fixture');
    },
  });
const grant = (count: number) =>
  Response.json({
    access_token: `synthetic-access-${count}`,
    refresh_token: `synthetic-refresh-${count}`,
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'Mail.ReadWrite Calendars.Read',
  });

beforeEach(async () => {
  db = await createTestDb();
  closed = new AbortController();
  now = 1_800_000_000_000;
  requests = [];
  respond = async (count) => grant(count);
  const identity = await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-instance');
  vault = new ConnectionVault(
    new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key'),
    identity
  );
  const tokens: ConnectionTokens = {
    accessToken: 'synthetic-access-0',
    refreshToken: 'synthetic-refresh-0',
    expiresAt: now + 30000,
    scopes: connection.scopes,
    client: { clientId: 'synthetic-microsoft-client' },
  };
  await save(connection);
  await vault.replace(connection, tokens);
  lifecycle = make();
});
afterEach(async () => {
  closed.abort();
  await db.close();
});

test('concurrent expiring access sends one refresh to the account tenant', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  respond = async (count) => {
    await gate;
    return grant(count);
  };
  const pending = Array.from({ length: 10 }, () => lifecycle.token(connection.id));
  release();
  const results = await Promise.all(pending);
  expect(results.every((result) => result.ok && result.accessToken === 'synthetic-access-1')).toBe(
    true
  );
  expect(requests).toEqual([
    {
      url: tokenUrl,
      form: {
        grant_type: 'refresh_token',
        refresh_token: 'synthetic-refresh-0',
        client_id: 'synthetic-microsoft-client',
        scope: scopes,
      },
    },
  ]);
});

test('every refresh rotates the refresh token and the newest one survives a restart', async () => {
  expect(await lifecycle.token(connection.id)).toMatchObject({ accessToken: 'synthetic-access-1' });
  now += 3600000;
  expect(await lifecycle.token(connection.id)).toMatchObject({ accessToken: 'synthetic-access-2' });
  closed.abort();
  closed = new AbortController();
  lifecycle = make();
  expect(await lifecycle.token(connection.id)).toMatchObject({ accessToken: 'synthetic-access-2' });
  expect(requests).toHaveLength(2);
  now += 3600000;
  expect(await lifecycle.token(connection.id)).toMatchObject({ accessToken: 'synthetic-access-3' });
  expect(requests.map((request) => request.form.refresh_token)).toEqual([
    'synthetic-refresh-0',
    'synthetic-refresh-1',
    'synthetic-refresh-2',
  ]);
  expect(await vault.read(connection)).toMatchObject({
    accessToken: 'synthetic-access-3',
    refreshToken: 'synthetic-refresh-3',
    expiresAt: now + 3600000,
  });
  expect((await read())[0].health).toBe('healthy');
});

test('invalid_grant shows reconnect needed with no retry loop', async () => {
  respond = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  expect(await lifecycle.token(connection.id)).toEqual({ ok: false, reason: 'reconnect_needed' });
  expect((await read())[0].health).toBe('reconnect_needed');
  for (let step = 0; step < 5; step++) {
    now += 86400000;
    expect(await lifecycle.token(connection.id)).toEqual({
      ok: false,
      reason: 'reconnect_needed',
    });
  }
  expect(requests).toHaveLength(1);
});

test('fully qualified Graph scopes from a refresh are stored as the requested names', async () => {
  respond = async (count) =>
    Response.json({
      access_token: `synthetic-access-${count}`,
      refresh_token: `synthetic-refresh-${count}`,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'https://graph.microsoft.com/mail.readwrite https://graph.microsoft.com/Calendars.Read openid',
    });
  expect(await lifecycle.token(connection.id)).toMatchObject({
    ok: true,
    scopes: ['Mail.ReadWrite', 'Calendars.Read', 'openid'],
  });
  expect((await vault.read(connection))?.scopes).toEqual(['Mail.ReadWrite', 'Calendars.Read', 'openid']);
});
