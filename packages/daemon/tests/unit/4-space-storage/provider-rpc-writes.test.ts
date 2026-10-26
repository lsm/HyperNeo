import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DbGateway, bindGateway } from '../../../src/storage/db-gateway/db-gateway';
import { Database } from '../../../src/storage/sqlite-compat';
import { createTables } from '../../../src/storage/schema/index';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { ProviderRepository } from '../../../src/storage/repositories/provider-repository';
import {
  providerRpcWrites,
  providerWriter,
} from '../../../src/storage/repositories/provider-rpc-writes';

describe('provider RPC writer commits', () => {
  let db: Database;
  let repo: ProviderRepository;
  let gateway: DbGateway;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    const reactive = createReactiveDatabase({ getDatabase: () => db } as never);
    repo = new ProviderRepository(db, reactive);
    gateway = new DbGateway(':memory:', db);
    bindGateway(db, gateway);
  });

  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  function params(providerId = 'synthetic-provider') {
    return {
      providerId,
      displayName: providerId,
      kind: 'built_in' as const,
      authType: 'none' as const,
      isEnabled: false,
    };
  }

  it('announces only committed provider rows outside the transaction', async () => {
    let announced = false;
    gateway.onChanges = (changes) => {
      db.exec('BEGIN IMMEDIATE');
      db.exec('ROLLBACK');
      expect(repo.getProviderByProviderId('synthetic-provider')?.displayName).toBe(
        'synthetic-provider'
      );
      expect(changes).toEqual([{ table: 'providers' }]);
      announced = true;
    };
    const result = await providerWriter(repo).call(providerRpcWrites, 'createProvider', params());
    expect(repo.getProvider(result.id)).toEqual(result);
    expect(announced).toBe(true);
  });

  it('retains one winner when two create commands use the same provider ID', async () => {
    const results = await Promise.allSettled([
      gateway.call(providerRpcWrites, 'createProvider', params()),
      gateway.call(providerRpcWrites, 'createProvider', params()),
    ]);
    expect(results.map((value) => value.status)).toEqual(['fulfilled', 'rejected']);
    expect(repo.countProviders()).toBe(1);
  });

  it('preserves unrelated provider fields when applying a partial update', async () => {
    const original = repo.createProvider({ ...params(), configJson: '{"command":"synthetic"}' });
    const updated = await gateway.call(providerRpcWrites, 'updateProvider', original.id, {
      displayName: 'Updated',
    });
    expect(updated).toMatchObject({
      displayName: 'Updated',
      configJson: original.configJson,
      authType: 'none',
      isEnabled: false,
    });
    expect(
      await gateway.call(providerRpcWrites, 'updateProvider', 'missing', { displayName: 'Missing' })
    ).toBeNull();
  });

  it('rolls back default clearing when selection of the new default fails', async () => {
    const original = repo.createProvider({ ...params('first'), isDefault: true });
    const next = repo.createProvider(params('next'));
    db.exec(`CREATE TRIGGER refuse_default BEFORE UPDATE ON providers
      WHEN NEW.id = '${next.id}' AND NEW.is_default = 1
      BEGIN SELECT RAISE(ABORT, 'synthetic default failure'); END`);
    await expect(gateway.call(providerRpcWrites, 'setDefaultProvider', next.id)).rejects.toThrow(
      'synthetic default failure'
    );
    expect(repo.getProvider(original.id)?.isDefault).toBe(true);
    expect(repo.getProvider(next.id)?.isDefault).toBe(false);
    await expect(gateway.call(providerRpcWrites, 'setDefaultProvider', 'missing')).rejects.toThrow(
      'not found'
    );
    expect(repo.getProvider(original.id)?.isDefault).toBe(true);
  });

  it('strips the latest discovery config after waiting for the writer', async () => {
    const record = repo.createProvider({ ...params(), configJson: '{"command":"old"}' });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = gateway.run.bind(gateway);
    gateway.run = async (op, input) => {
      await hold;
      return run(op, input);
    };
    const pending = gateway.call(providerRpcWrites, 'stripDiscovery', record.providerId);
    repo.updateProvider(record.id, {
      configJson: JSON.stringify({
        command: 'new',
        discoveredModels: { models: [{ id: 'cached' }] },
      }),
    });
    release();
    await pending;
    expect(JSON.parse(repo.getProvider(record.id)!.configJson!)).toEqual({ command: 'new' });
  });

  it('leaves invalid or absent discovery configurations unchanged', async () => {
    const record = repo.createProvider({ ...params(), configJson: 'invalid-json' });
    await gateway.call(providerRpcWrites, 'stripDiscovery', record.providerId);
    expect(repo.getProvider(record.id)?.configJson).toBe('invalid-json');
    await gateway.call(providerRpcWrites, 'stripDiscovery', 'missing');
    expect(repo.countProviders()).toBe(1);
  });

  it('records only auth metadata without changing provider configuration', async () => {
    const record = repo.createProvider({ ...params(), configJson: '{"command":"keep"}' });
    await gateway.call(providerRpcWrites, 'recordAuth', record.providerId, 'oauth', 'healthy');
    expect(repo.getProvider(record.id)).toMatchObject({
      authType: 'oauth',
      healthStatus: 'healthy',
      configJson: record.configJson,
    });
    await gateway.call(providerRpcWrites, 'recordAuth', record.id, 'api_key', 'unhealthy');
    expect(repo.getProvider(record.id)).toMatchObject({
      authType: 'api_key',
      healthStatus: 'unhealthy',
    });
  });

  it('returns a writer failure without mutating the main connection', async () => {
    const original = repo.createProvider(params());
    bindGateway(
      db,
      new DbGateway('synthetic-file', null, undefined, () => {
        throw new Error('writer unavailable');
      })
    );
    await expect(
      providerWriter(repo).call(providerRpcWrites, 'deleteProvider', original.id)
    ).rejects.toThrow('writer unavailable');
    expect(repo.getProvider(original.id)).toEqual(original);
  });
});
