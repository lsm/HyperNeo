import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { runMigration467 } from '../../../../src/storage/schema/m467-google-connections.ts';
import {
  googleConnectionReads,
  googleConnectionWrites,
} from '../../../../src/storage/repositories/google-connections.ts';
import { ConnectionVault } from '../../../../src/lib/connections/vault.ts';
import {
  DatabaseCredentialStore,
  KeychainStatusCredentialStore,
  KeychainUnavailableError,
  type CredentialStore,
} from '../../../../src/lib/credentials/credential-store.ts';
import { createTestDb } from '../../../helpers/database.ts';
import { createDatabaseOperationCatalog } from '../../../../src/lib/operations/database-catalog.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const account = {
  id: 'connection-1',
  provider: 'google' as const,
  accountId: 'subject-1',
  email: 'one@example.test',
  scopes: ['openid', 'email'],
  health: 'healthy' as const,
};
const tokens = {
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  expiresAt: 1234,
  scopes: ['openid', 'email'],
};
let db: Database;
let gateway: DbGateway;
let store: DatabaseCredentialStore;

beforeEach(() => {
  db = new Database(':memory:');
  runMigration467(db);
  store = new DatabaseCredentialStore(db, 'synthetic-encryption-key');
  gateway = new DbGateway(':memory:', db);
  bindGateway(db, gateway);
});
afterEach(async () => {
  await gateway.close();
  db.close();
});

test('new instances start empty; durable metadata is an explicit secret-free projection', async () => {
  expect(await gateway.call(googleConnectionReads, 'list')).toEqual([]);
  await gateway.call(googleConnectionWrites, 'put', {
    ...account,
    accessToken: 'must-not-persist',
  });
  expect(await gateway.call(googleConnectionReads, 'list')).toEqual([account]);
  expect(JSON.stringify(db.prepare('SELECT * FROM google_connections').all())).not.toContain(
    'must-not-persist'
  );
  runMigration467(db);
  expect(await gateway.call(googleConnectionReads, 'list')).toEqual([account]);
  await expect(
    gateway.call(googleConnectionWrites, 'put', { ...account, id: 'duplicate' })
  ).rejects.toThrow();
});

test('vault isolates instances, accounts, connections and grants with one atomic bundle', async () => {
  const first = new ConnectionVault(store, 'instance-1');
  const second = new ConnectionVault(store, 'instance-2');
  await first.replace(account, tokens);
  expect(await first.read(account)).toEqual(tokens);
  expect(await second.read(account)).toBeNull();
  expect(await first.read({ ...account, accountId: 'subject-2' })).toBeNull();
  expect(await first.read({ ...account, id: 'connection-2' })).toBeNull();
  expect(JSON.stringify(db.prepare('SELECT * FROM provider_credentials').all())).not.toContain(
    'synthetic-access'
  );
  db.exec(
    "CREATE TRIGGER fail_replace BEFORE INSERT ON provider_credentials BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"
  );
  await expect(first.replace(account, { ...tokens, accessToken: 'replacement' })).rejects.toThrow(
    'synthetic failure'
  );
  expect(await first.read(account)).toEqual(tokens);
  db.exec('DROP TRIGGER fail_replace');
  await second.replace(account, { ...tokens, accessToken: 'other-instance' });
  await first.remove(account);
  expect(await first.read(account)).toBeNull();
  expect((await second.read(account))?.accessToken).toBe('other-instance');
});

test('synthetic Keychain and encrypted fallback retain the same namespaced contract', async () => {
  const values = new Map<string, string>();
  const keychain: CredentialStore = {
    get: async (service, id) => values.get(JSON.stringify([service, id])) ?? null,
    set: vi.fn(async (service, id, data) => {
      values.set(JSON.stringify([service, id]), data);
    }),
    delete: async (service, id) => {
      values.delete(JSON.stringify([service, id]));
    },
    listServices: async () => [],
  };
  const backend = new KeychainStatusCredentialStore(keychain, store);
  const vault = new ConnectionVault(backend, 'instance-1');
  await vault.replace(account, tokens);
  expect(await vault.read(account)).toEqual(tokens);
  keychain.set = async () => {
    throw new KeychainUnavailableError('synthetic locked keychain');
  };
  await vault.replace({ ...account, id: 'fallback' }, tokens);
  expect(await vault.read({ ...account, id: 'fallback' })).toEqual(tokens);
  expect(vault.storageStatus().backend).toBe('keychain-fallback');
});

test('human status operation returns metadata only and refuses agent management access', async () => {
  const database = await createTestDb();
  try {
    const sql = database.getDatabase();
    const writer = new DbGateway(':memory:', sql);
    await writer.call(googleConnectionWrites, 'put', account);
    const registry = createDatabaseOperationCatalog(database);
    const result = await invokeOperation(
      registry,
      'connections.list',
      {},
      { source: 'rpc', principal: 'local' }
    );
    expect(result).toMatchObject({ kind: 'completed', value: { connections: [account] } });
    const denied = await invokeOperation(
      registry,
      'connections.list',
      {},
      { source: 'mcp', sessionId: 'synthetic-worker', role: 'neo' }
    );
    expect(denied).toMatchObject({ kind: 'error', error: { code: 'forbidden' } });
    await writer.close();
  } finally {
    database.close();
  }
});
