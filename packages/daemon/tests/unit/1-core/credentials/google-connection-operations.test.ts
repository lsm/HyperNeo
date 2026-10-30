import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { createGoogleConnectionOperations } from '../../../../src/lib/connections/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { startGoogleLogin } from '../../../../src/lib/connections/google-login.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';

type Attempt = Awaited<ReturnType<typeof startGoogleLogin>>;
type Outcome = Awaited<Attempt['result']>;
let db: Awaited<ReturnType<typeof createTestDb>>;
let store: DatabaseCredentialStore;
let attempts: Array<ReturnType<typeof Promise.withResolvers<Outcome>>>;
let registry: ReturnType<typeof createOperationRegistry>;
const client = { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' };
const success = {
  ok: true as const,
  accountId: 'subject-1',
  email: 'one@example.test',
  tokens: {
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3600000,
    scopes: ['openid', 'email'],
  },
};

beforeEach(async () => {
  db = await createTestDb();
  store = new DatabaseCredentialStore(db.getDatabase(), 'synthetic-key');
  attempts = [];
  registry = createOperationRegistry(
    createGoogleConnectionOperations(() => db.getDatabase(), {
      createStore: () => store,
      startLogin: async () => {
        const attempt = Promise.withResolvers<Outcome>();
        attempts.push(attempt);
        return {
          authorizeUrl: 'https://accounts.google.com/synthetic-consent',
          result: attempt.promise,
          cancel: () => attempt.resolve({ ok: false, reason: 'cancelled' }),
        };
      },
    })
  );
});
afterEach(() => db.close());

async function call(name: string, input: unknown = {}) {
  const outcome = await invokeOperation(registry, name, input, {
    source: 'rpc',
    principal: 'local',
  });
  expect(outcome.kind).toBe('completed');
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value as {
    state: string;
    loginId: string;
    connectionId: string;
    reason?: string;
    authorizeUrl?: string;
    ok?: boolean;
  };
}
const status = (loginId: string) => call('connections.google.login', { loginId });
async function settle(loginId: string) {
  await vi.waitFor(async () => {
    expect((await status(loginId)).state).not.toBe('pending');
  });
  return status(loginId);
}

test('connect stores a verified grant and returns no credentials in operation responses', async () => {
  const start = await call('connections.google.connect', client);
  expect(start).toMatchObject({
    state: 'pending',
    authorizeUrl: 'https://accounts.google.com/synthetic-consent',
  });
  attempts[0].resolve(success);
  const connected = await settle(start.loginId);
  expect(connected.state).toBe('complete');
  expect(JSON.stringify([start, connected])).not.toContain('synthetic-access');
  expect(JSON.stringify([start, connected])).not.toContain(client.clientSecret);
  const rows = db.getDatabase().prepare('SELECT status_json FROM google_connections').all() as {
    status_json: string;
  }[];
  expect(rows.map((row) => JSON.parse(row.status_json))).toEqual([
    {
      id: connected.connectionId,
      provider: 'google',
      accountId: 'subject-1',
      email: 'one@example.test',
      scopes: ['openid', 'email'],
      health: 'healthy',
    },
  ]);
  expect(JSON.stringify(rows)).not.toContain('synthetic-refresh');
  const encrypted = db.getDatabase().prepare('SELECT * FROM provider_credentials').all();
  expect(encrypted).toHaveLength(1);
  expect(JSON.stringify(encrypted)).not.toContain('synthetic-access');
  const identity = db
    .getDatabase()
    .prepare('SELECT daemon_id FROM artifact_file_identity')
    .get() as { daemon_id: string };
  const connection = JSON.parse(rows[0].status_json);
  expect((await new ConnectionVault(store, identity.daemon_id).read(connection))?.client).toEqual(
    client
  );
});

test('reconnect refuses another account and preserves the existing healthy grant', async () => {
  const start = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  const first = await settle(start.loginId);
  const reconnect = await call('connections.google.connect', {
    ...client,
    connectionId: first.connectionId,
  });
  attempts[1].resolve({ ...success, accountId: 'different-subject' });
  expect(await settle(reconnect.loginId)).toMatchObject({
    state: 'failed',
    reason: 'account_mismatch',
  });
  const row = db.getDatabase().prepare('SELECT status_json FROM google_connections').get() as {
    status_json: string;
  };
  expect(JSON.parse(row.status_json).health).toBe('healthy');
});

test('reconnect reuses the saved client without returning its secret to the caller', async () => {
  const start = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  const first = await settle(start.loginId);
  const reconnect = await call('connections.google.connect', {
    connectionId: first.connectionId,
  });
  expect(reconnect.state).toBe('pending');
  attempts[1].resolve(success);
  expect(await settle(reconnect.loginId)).toMatchObject({
    state: 'complete',
    connectionId: first.connectionId,
  });
  expect(JSON.stringify(reconnect)).not.toContain(client.clientSecret);
});

test('disconnect cancels a pending reconnect, disables the account and erases only its bundle', async () => {
  const start = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  const first = await settle(start.loginId);
  const reconnect = await call('connections.google.connect', {
    ...client,
    connectionId: first.connectionId,
  });
  expect(await call('connections.google.disconnect', { connectionId: first.connectionId })).toEqual(
    { ok: true }
  );
  attempts[1].resolve(success);
  expect((await settle(reconnect.loginId)).state).toBe('failed');
  const rows = db.getDatabase().prepare('SELECT status_json FROM google_connections').all() as {
    status_json: string;
  }[];
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].status_json).health).toBe('disconnected');
  expect(db.getDatabase().prepare('SELECT * FROM provider_credentials').all()).toEqual([]);
});

test('a failed vault replacement cannot report a healthy or completed connection', async () => {
  const start = await call('connections.google.connect', client);
  db.getDatabase().exec(
    "CREATE TRIGGER fail_google_vault BEFORE INSERT ON provider_credentials BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"
  );
  attempts[0].resolve(success);
  expect(await settle(start.loginId)).toMatchObject({ state: 'failed', reason: 'storage_failed' });
  const row = db.getDatabase().prepare('SELECT status_json FROM google_connections').get() as {
    status_json: string;
  };
  expect(JSON.parse(row.status_json).health).toBe('reconnect_needed');
});

test('one active consent attempt replaces the prior attempt without accepting its late result', async () => {
  const old = await call('connections.google.connect', client);
  const fresh = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  attempts[1].resolve(success);
  expect((await status(old.loginId)).state).toBe('missing');
  expect((await settle(fresh.loginId)).state).toBe('complete');
  expect(db.getDatabase().prepare('SELECT * FROM google_connections').all()).toHaveLength(1);
});

test('agent management is refused before opening a listener or reading credentials', async () => {
  for (const [name, input] of [
    ['connections.google.connect', client],
    ['connections.google.login', { loginId: 'unknown' }],
    ['connections.google.disconnect', { connectionId: 'unknown' }],
  ] as const) {
    expect(
      await invokeOperation(registry, name, input, {
        source: 'mcp',
        sessionId: 'synthetic-worker',
        role: 'neo',
      })
    ).toMatchObject({ kind: 'failed', code: 'forbidden' });
  }
  expect(attempts).toHaveLength(0);
});

test('connecting an already known Google account keeps its stable connection id', async () => {
  const first = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  const connected = await settle(first.loginId);
  const again = await call('connections.google.connect', client);
  attempts[1].resolve(success);
  expect(await settle(again.loginId)).toMatchObject({ connectionId: connected.connectionId });
  expect(db.getDatabase().prepare('SELECT * FROM google_connections').all()).toHaveLength(1);
});

test('failed credential erasure is explicit while the connection remains disabled', async () => {
  const start = await call('connections.google.connect', client);
  attempts[0].resolve(success);
  const connected = await settle(start.loginId);
  vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('synthetic secret detail'));
  expect(
    await call('connections.google.disconnect', { connectionId: connected.connectionId })
  ).toEqual({ ok: false, reason: 'credential_delete_failed' });
  const row = db.getDatabase().prepare('SELECT status_json FROM google_connections').get() as {
    status_json: string;
  };
  expect(JSON.parse(row.status_json).health).toBe('disconnected');
  expect(db.getDatabase().prepare('SELECT * FROM provider_credentials').all()).toHaveLength(1);
  expect(
    await call('connections.google.disconnect', { connectionId: connected.connectionId })
  ).toEqual({ ok: true });
});

test('storage warnings are visible but extra secret fields cannot cross the status door', async () => {
  Object.assign(store, {
    getStatus: () => ({
      backend: 'keychain-fallback',
      keychainAvailable: false,
      warning: 'Synthetic degraded storage',
      accessToken: 'must-not-cross-status',
    }),
  });
  const response = await call('connections.google.login');
  expect(response).toMatchObject({
    state: 'missing',
    storage: { backend: 'keychain-fallback', warning: 'Synthetic degraded storage' },
  });
  expect(JSON.stringify(response)).not.toContain('must-not-cross-status');
});
