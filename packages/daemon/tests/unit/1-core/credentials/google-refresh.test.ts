import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
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

type Access = { ok: true; accessToken: string; expiresAt: number } | { ok: false; reason: string };
let db: Awaited<ReturnType<typeof createTestDb>>;
let vault: ConnectionVault;
let lifecycle: ReturnType<typeof createConnectionLifecycle>;
let closed: AbortController;
let now: number;
let tokens: ConnectionTokens;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
const connection: ConnectionStatus = {
  id: 'synthetic-google',
  provider: 'google',
  accountId: 'synthetic-subject',
  email: 'one@example.test',
  scopes: ['openid', 'email'],
  health: 'healthy',
};
const grant = {
  access_token: 'synthetic-new-access',
  refresh_token: 'synthetic-rotated-refresh',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: 'openid email',
};
const token = () =>
  (lifecycle as unknown as { token: (id: string) => Promise<Access> }).token(connection.id);
const read = () => db.gateway.call(googleConnectionReads, 'list');
const save = (row: ConnectionStatus) => db.gateway.call(googleConnectionWrites, 'put', row);
const make = () =>
  createConnectionLifecycle({
    read,
    save,
    vault,
    closed: closed.signal,
    fetchImpl,
    now: () => now,
    startLogin: async () => {
      throw new Error('Login is not part of this fixture');
    },
  } as Parameters<typeof createConnectionLifecycle>[0] & {
    fetchImpl: typeof fetch;
    now: () => number;
  });

beforeEach(async () => {
  db = await createTestDb();
  closed = new AbortController();
  now = Date.now();
  const identity = await db.gateway.call(artifactIdentityWrites, 'ensure', 'synthetic-instance');
  vault = new ConnectionVault(
    new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key'),
    identity
  );
  tokens = {
    accessToken: 'synthetic-old-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: now + 30000,
    scopes: ['openid', 'email'],
    client: { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' },
  };
  await save(connection);
  await vault.replace(connection, tokens);
  fetchImpl = vi.fn<typeof fetch>(async () => Response.json(grant));
  lifecycle = make();
});
afterEach(async () => {
  closed.abort();
  await db.close();
});

test('concurrent expiring access refreshes once and persists the rotated bundle across restart', async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => token()));
  expect(results.every((result) => result.ok && result.accessToken === grant.access_token)).toBe(
    true
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://oauth2.googleapis.com/token');
  expect(init?.redirect).toBe('error');
  expect(Object.fromEntries(new URLSearchParams(init?.body as URLSearchParams))).toEqual({
    grant_type: 'refresh_token',
    refresh_token: 'synthetic-refresh',
    client_id: 'synthetic-client',
    client_secret: 'synthetic-client-secret',
  });
  expect(await vault.read(connection)).toMatchObject({
    accessToken: grant.access_token,
    refreshToken: grant.refresh_token,
    expiresAt: now + 3600000,
    client: tokens.client,
  });
  lifecycle = make();
  expect(await token()).toMatchObject({ ok: true, accessToken: grant.access_token });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(
    JSON.stringify(db.getDatabase().prepare('SELECT * FROM provider_credentials').all())
  ).not.toContain(grant.refresh_token);
});

test('an omitted refresh token and scopes preserve the original grant', async () => {
  fetchImpl.mockResolvedValue(
    Response.json({ access_token: 'synthetic-renewed', expires_in: 3600, token_type: 'Bearer' })
  );
  expect(await token()).toMatchObject({ ok: true, accessToken: 'synthetic-renewed' });
  expect(await vault.read(connection)).toMatchObject({
    refreshToken: tokens.refreshToken,
    scopes: tokens.scopes,
  });
});

test('a grant outside the refresh window is used without a request', async () => {
  await vault.replace(connection, { ...tokens, expiresAt: now + 3600000 });
  expect(await token()).toMatchObject({ ok: true, accessToken: tokens.accessToken });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('invalid_grant requires reconnect and never retries while the connection stays disabled', async () => {
  fetchImpl.mockImplementation(async () =>
    Response.json(
      { error: 'invalid_grant', error_description: 'synthetic-sensitive-detail' },
      { status: 400 }
    )
  );
  expect(await token()).toEqual({ ok: false, reason: 'reconnect_needed' });
  expect((await read())[0].health).toBe('reconnect_needed');
  now += 86400000;
  for (let n = 0; n < 5; n++)
    expect(await token()).toEqual({ ok: false, reason: 'reconnect_needed' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('transient failure backs off, uses only an unexpired token, then recovers', async () => {
  fetchImpl.mockImplementation(async () =>
    Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
  );
  expect(await token()).toMatchObject({ ok: true, accessToken: tokens.accessToken });
  now += 31000;
  expect(await token()).toEqual({ ok: false, reason: 'refresh_failed' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  now += 30000;
  fetchImpl.mockImplementation(async () => Response.json(grant));
  expect(await token()).toMatchObject({ ok: true, accessToken: grant.access_token });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test.each([
  () => new Response('not-json'),
  () => Response.json({ ...grant, token_type: 'MAC' }),
  () => new Response('x'.repeat(65537)),
])('malformed or oversized responses never replace a usable bundle', async (response) => {
  fetchImpl.mockImplementation(async () => response());
  expect(await token()).toMatchObject({ ok: true, accessToken: tokens.accessToken });
  expect(await vault.read(connection)).toEqual(tokens);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('missing offline credentials require reconnect without contacting Google', async () => {
  await vault.replace(connection, { ...tokens, refreshToken: undefined });
  expect(await token()).toEqual({ ok: false, reason: 'reconnect_needed' });
  expect((await read())[0].health).toBe('reconnect_needed');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('disconnect aborts an in-flight refresh and a late grant cannot resurrect the bundle', async () => {
  let aborted = false;
  fetchImpl.mockImplementation(
    async (_url, init) =>
      new Promise<Response>((resolve) => {
        init!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve(Response.json(grant));
          },
          { once: true }
        );
      })
  );
  const pending = token();
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  const disconnect = lifecycle.disconnect(connection.id);
  expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
  expect(await disconnect).toEqual({ ok: true });
  expect(aborted).toBe(true);
  expect(await vault.read(connection)).toBeNull();
  expect((await read())[0].health).toBe('disconnected');
});
