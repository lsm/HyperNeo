import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { ProviderRepository } from '../../../../src/storage/repositories/provider-repository';
import { createTables, runMigration147 } from '../../../../src/storage/schema';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';

describe('ProviderRepository', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let repo: ProviderRepository;
  let notifyChangeSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createTables(bunDb);
    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
    notifyChangeSpy = mock(() => {});
    reactiveDb.notifyChange = notifyChangeSpy;
    repo = new ProviderRepository(bunDb, reactiveDb);
  });

  afterEach(() => {
    bunDb.close();
  });

  test('fresh schema creates providers table and lists empty providers', () => {
    const table = bunDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'`)
      .get();

    expect(table).toBeTruthy();
    expect(repo.listProviders()).toEqual([]);
  });

  test('creates and gets provider by id and providerId', () => {
    const provider = repo.createProvider({
      providerId: 'custom:lmstudio',
      displayName: 'LM Studio',
      kind: 'custom_endpoint',
      authType: 'none',
      isEnabled: false,
      isDefault: true,
      sortOrder: 20,
      baseUrl: 'http://localhost:1234/v1',
      configJson: '{"model":"local"}',
      customEndpointConfigJson: '{"type":"openai"}',
      healthStatus: 'healthy',
      lastHealthCheckAt: 123,
    });

    expect(provider.id).toBeTruthy();
    expect(provider.providerId).toBe('custom:lmstudio');
    expect(provider.displayName).toBe('LM Studio');
    expect(provider.kind).toBe('custom_endpoint');
    expect(provider.authType).toBe('none');
    expect(provider.isEnabled).toBe(false);
    expect(provider.isDefault).toBe(true);
    expect(provider.sortOrder).toBe(20);
    expect(provider.baseUrl).toBe('http://localhost:1234/v1');
    expect(provider.configJson).toBe('{"model":"local"}');
    expect(provider.customEndpointConfigJson).toBe('{"type":"openai"}');
    expect(provider.healthStatus).toBe('healthy');
    expect(provider.lastHealthCheckAt).toBe(123);
    expect(provider.createdAt).toBeTruthy();
    expect(provider.updatedAt).toBeTruthy();
    expect(repo.getProvider(provider.id)).toEqual(provider);
    expect(repo.getProviderByProviderId('custom:lmstudio')).toEqual(provider);
  });

  test('applies create defaults', () => {
    const provider = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 10,
    });

    expect(provider.isEnabled).toBe(true);
    expect(provider.isDefault).toBe(false);
    expect(provider.healthStatus).toBe('unknown');
    expect(provider.baseUrl).toBeUndefined();
    expect(provider.configJson).toBeUndefined();
    expect(provider.customEndpointConfigJson).toBeUndefined();
    expect(provider.lastHealthCheckAt).toBeUndefined();
  });

  test('lists providers by sort_order ascending', () => {
    repo.createProvider({
      providerId: 'third',
      displayName: 'Third',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 30,
    });
    repo.createProvider({
      providerId: 'first',
      displayName: 'First',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 10,
    });
    repo.createProvider({
      providerId: 'second',
      displayName: 'Second',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 20,
    });

    expect(repo.listProviders().map((provider) => provider.providerId)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('updates provider fields and clears optional fields', () => {
    const provider = repo.createProvider({
      providerId: 'custom:old',
      displayName: 'Old',
      kind: 'custom_endpoint',
      authType: 'api_key',
      sortOrder: 10,
      baseUrl: 'http://old.test',
      configJson: '{}',
      customEndpointConfigJson: '{}',
      healthStatus: 'unhealthy',
      lastHealthCheckAt: 100,
    });

    const updated = repo.updateProvider(provider.id, {
      providerId: 'custom:new',
      displayName: 'New',
      kind: 'built_in',
      authType: 'oauth',
      isEnabled: false,
      isDefault: true,
      sortOrder: 5,
      baseUrl: undefined,
      configJson: undefined,
      customEndpointConfigJson: undefined,
      healthStatus: 'healthy',
      lastHealthCheckAt: undefined,
    });

    expect(updated).toMatchObject({
      id: provider.id,
      providerId: 'custom:new',
      displayName: 'New',
      kind: 'built_in',
      authType: 'oauth',
      isEnabled: false,
      isDefault: true,
      sortOrder: 5,
      healthStatus: 'healthy',
    });
    expect(updated!.baseUrl).toBeUndefined();
    expect(updated!.configJson).toBeUndefined();
    expect(updated!.customEndpointConfigJson).toBeUndefined();
    expect(updated!.lastHealthCheckAt).toBeUndefined();
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(provider.updatedAt);
  });

  test('returns null when updating unknown provider', () => {
    expect(repo.updateProvider('missing', { displayName: 'Missing' })).toBeNull();
  });

  test('deletes provider and returns delete status', () => {
    const provider = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 10,
    });

    expect(repo.deleteProvider(provider.id)).toBe(true);
    expect(repo.getProvider(provider.id)).toBeNull();
    expect(repo.deleteProvider(provider.id)).toBe(false);
  });

  test('setDefaultProvider leaves exactly one default provider', () => {
    const first = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
      isDefault: true,
      sortOrder: 10,
    });
    const second = repo.createProvider({
      providerId: 'custom:lmstudio',
      displayName: 'LM Studio',
      kind: 'custom_endpoint',
      authType: 'none',
      sortOrder: 20,
    });

    repo.setDefaultProvider(second.id);

    expect(repo.getProvider(first.id)!.isDefault).toBe(false);
    expect(repo.getProvider(second.id)!.isDefault).toBe(true);
    expect(repo.listProviders().filter((provider) => provider.isDefault)).toHaveLength(1);
  });

  test('notifies providers live query after writes', () => {
    notifyChangeSpy.mockClear();
    const provider = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
      sortOrder: 10,
    });
    repo.updateProvider(provider.id, { displayName: 'Claude' });
    repo.setDefaultProvider(provider.id);
    repo.deleteProvider(provider.id);

    expect(notifyChangeSpy).toHaveBeenCalledTimes(4);
    expect(notifyChangeSpy).toHaveBeenCalledWith('providers');
  });

  test('does not notify when update or delete target is missing', () => {
    notifyChangeSpy.mockClear();
    repo.updateProvider('missing', { displayName: 'Missing' });
    repo.deleteProvider('missing');

    expect(notifyChangeSpy).not.toHaveBeenCalled();
  });
});

describe('Migration 147: providers table', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`CREATE TABLE existing_table (id TEXT PRIMARY KEY)`);
  });

  afterEach(() => {
    db.close();
  });

  test('creates providers table and indexes without changing existing tables', () => {
    runMigration147(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(['existing_table', 'providers']);

    for (const indexName of ['idx_providers_provider_id', 'idx_providers_sort_order']) {
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
          .get(indexName)
      ).toBeTruthy();
    }
  });

  test('is idempotent', () => {
    runMigration147(db);
    runMigration147(db);

    const providerTables = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'providers'`
      )
      .get() as { count: number };
    expect(providerTables.count).toBe(1);
  });
});
