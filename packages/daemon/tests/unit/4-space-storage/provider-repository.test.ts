import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import { createTables } from '../../../src/storage/schema/index';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import { ProviderRepository } from '../../../src/storage/repositories/provider-repository';

describe('ProviderRepository', () => {
  let db: Database;
  let reactiveDb: ReturnType<typeof createReactiveDatabase>;
  let repo: ProviderRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    reactiveDb = createReactiveDatabase({
      getDatabase: () => db,
    } as unknown as import('../../../src/storage/database').Database);
    repo = new ProviderRepository(db, reactiveDb);
  });

  afterEach(() => {
    db.close();
  });

  it('creates a provider', () => {
    const record = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });

    expect(record.providerId).toBe('anthropic');
    expect(record.displayName).toBe('Anthropic');
    expect(record.isEnabled).toBe(true);
    expect(record.isDefault).toBe(false);
    expect(record.healthStatus).toBe('unknown');
  });

  it('lists providers ordered by sort_order', () => {
    repo.createProvider({
      providerId: 'b',
      displayName: 'B',
      kind: 'built_in',
      authType: 'none',
      sortOrder: 2,
    });
    repo.createProvider({
      providerId: 'a',
      displayName: 'A',
      kind: 'built_in',
      authType: 'none',
      sortOrder: 1,
    });

    const list = repo.listProviders();
    expect(list.map((r) => r.providerId)).toEqual(['a', 'b']);
  });

  it('gets provider by id and by providerId', () => {
    const created = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });

    expect(repo.getProvider(created.id)?.providerId).toBe('anthropic');
    expect(repo.getProviderByProviderId('anthropic')?.id).toBe(created.id);
    expect(repo.getProviderByProviderId('missing')).toBeNull();
  });

  it('updates a provider', () => {
    const created = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });

    const updated = repo.updateProvider(created.id, {
      displayName: 'Anthropic Inc',
      healthStatus: 'healthy',
    });
    expect(updated?.displayName).toBe('Anthropic Inc');
    expect(updated?.healthStatus).toBe('healthy');
  });

  it('update returns null for missing provider', () => {
    expect(repo.updateProvider('missing', { displayName: 'X' })).toBeNull();
  });

  it('deletes a provider', () => {
    const created = repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });

    expect(repo.deleteProvider(created.id)).toBe(true);
    expect(repo.getProvider(created.id)).toBeNull();
    expect(repo.deleteProvider(created.id)).toBe(false);
  });

  it('setDefaultProvider clears others', () => {
    const a = repo.createProvider({
      providerId: 'a',
      displayName: 'A',
      kind: 'built_in',
      authType: 'none',
      isDefault: true,
    });
    const b = repo.createProvider({
      providerId: 'b',
      displayName: 'B',
      kind: 'built_in',
      authType: 'none',
    });

    expect(repo.getProvider(a.id)?.isDefault).toBe(true);
    repo.setDefaultProvider(b.id);
    expect(repo.getProvider(a.id)?.isDefault).toBe(false);
    expect(repo.getProvider(b.id)?.isDefault).toBe(true);
  });

  it('rejects duplicate providerId', () => {
    repo.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });
    expect(() => {
      repo.createProvider({
        providerId: 'anthropic',
        displayName: 'Anthropic 2',
        kind: 'built_in',
        authType: 'api_key',
      });
    }).toThrow('already exists');
  });

  it('countProviders returns correct count', () => {
    expect(repo.countProviders()).toBe(0);
    repo.createProvider({ providerId: 'a', displayName: 'A', kind: 'built_in', authType: 'none' });
    expect(repo.countProviders()).toBe(1);
  });
});
