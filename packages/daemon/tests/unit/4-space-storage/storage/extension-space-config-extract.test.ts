import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import type { SpaceExternalEventSourceConfig } from '../../../../src/lib/external-events/types';

type Persist = (
  db: Database,
  spaceId: string,
  source: string,
  config: SpaceExternalEventSourceConfig,
  now: number
) => void;
const config: SpaceExternalEventSourceConfig = {
  spaceId: 'synthetic-one',
  source: 'github',
  enabled: true,
  settings: { label: 'Synthetic 🦊', nested: { enabled: false } },
};
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/space-extension-config-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Space extension SQL helper is unavailable');
  return (await import(file.href)).persistSpaceExtensionConfig;
}
describe('Space extension configuration SQL extraction', () => {
  let db: Database;
  let store: ExternalEventExtensionConfigStore;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-one'),('synthetic-two')"
    );
    store = new ExternalEventExtensionConfigStore(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const row = () =>
    db
      .prepare('SELECT * FROM space_external_event_source_configs WHERE space_id=? AND source=?')
      .get(config.spaceId, config.source);
  test('legacy update preserves creation time and exact settings JSON', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    await store.setSpaceConfig(config.spaceId, config.source, config);
    expect(row()).toEqual({
      space_id: config.spaceId,
      source: 'github',
      enabled: 1,
      settings_json: '{"label":"Synthetic 🦊","nested":{"enabled":false}}',
      created_at: 41,
      updated_at: 41,
    });
    clock.mockReturnValue(99);
    await store.setSpaceConfig(config.spaceId, config.source, {
      ...config,
      enabled: false,
      settings: {},
    });
    expect(row()).toEqual({
      space_id: config.spaceId,
      source: 'github',
      enabled: 0,
      settings_json: '{}',
      created_at: 41,
      updated_at: 99,
    });
  });
  test('legacy compound keys isolate Spaces and sources', async () => {
    await store.setSpaceConfig(config.spaceId, config.source, config);
    await store.setSpaceConfig('synthetic-two', 'github', { ...config, spaceId: 'synthetic-two' });
    await store.setSpaceConfig(config.spaceId, 'synthetic-other', {
      ...config,
      source: 'synthetic-other',
    });
    await store.setSpaceConfig(config.spaceId, 'github', { ...config, enabled: false });
    expect(await store.listEnabledSpaces('github')).toEqual([
      { ...config, spaceId: 'synthetic-two' },
    ]);
    expect(await store.getSpaceConfig(config.spaceId, 'synthetic-other')).toEqual({
      ...config,
      source: 'synthetic-other',
    });
  });
  test('legacy validation rejects before clock or prepare; JSON failure writes nothing', async () => {
    const clock = vi.spyOn(Date, 'now'),
      prepare = vi.spyOn(db, 'prepare');
    await expect(store.setSpaceConfig(' wrong ', 'github', config)).rejects.toThrow('whitespace');
    await expect(store.setSpaceConfig(config.spaceId, ' wrong ', config)).rejects.toThrow(
      'whitespace'
    );
    await expect(store.setSpaceConfig('synthetic-two', 'github', config)).rejects.toThrow(
      'must match'
    );
    await expect(store.setSpaceConfig(config.spaceId, 'other', config)).rejects.toThrow(
      'must match'
    );
    await expect(
      store.setSpaceConfig(config.spaceId, 'github', {
        ...config,
        settings: [] as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('settings must be an object');
    expect(clock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      store.setSpaceConfig(config.spaceId, 'github', {
        ...config,
        settings: {
          toJSON() {
            throw new Error('synthetic JSON failure');
          },
        },
      })
    ).rejects.toThrow('synthetic JSON failure');
    expect(row()).toBeNull();
  });
  test('helper preserves all six bindings and full row without reading a clock', async () => {
    const persist = await persistence(),
      captures: unknown[][] = [],
      prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].includes('INSERT INTO space_external_event_source_configs')) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') captures.push(bindings);
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    await store.setSpaceConfig(config.spaceId, 'github', config);
    const legacy = row();
    db.prepare('DELETE FROM space_external_event_source_configs').run();
    clock.mockImplementation(() => {
      throw new Error('helper must use caller time');
    });
    clock.mockClear();
    expect(persist(db, config.spaceId, 'github', config, 41)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
    expect(row()).toEqual(legacy);
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual(captures[1]);
    expect(captures[1]).toEqual([
      config.spaceId,
      'github',
      1,
      '{"label":"Synthetic 🦊","nested":{"enabled":false}}',
      41,
      41,
    ]);
  });
  test('helper preserves insert/update rollback and parent cascade', async () => {
    const persist = await persistence();
    expect(() =>
      db.transaction(() => {
        persist(db, config.spaceId, 'github', config, 41);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(row()).toBeNull();
    persist(db, config.spaceId, 'github', config, 41);
    const before = row();
    expect(() =>
      db.transaction(() => {
        persist(db, config.spaceId, 'github', { ...config, enabled: false }, 99);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(row()).toEqual(before);
    db.prepare('DELETE FROM spaces WHERE id=?').run(config.spaceId);
    expect(row()).toBeNull();
  });
});
