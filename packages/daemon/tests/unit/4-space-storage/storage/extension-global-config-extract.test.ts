import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import type { ExternalEventExtensionConfig } from '../../../../src/lib/external-events/types';

type Persist = (
  db: Database,
  source: string,
  config: ExternalEventExtensionConfig,
  now: number
) => void;
const config: ExternalEventExtensionConfig = {
  source: 'synthetic-extension',
  globallyEnabled: true,
  capabilities: { polling: true, webhooks: false },
  secretsRef: 'synthetic-reference',
  settings: { label: 'Synthetic 🦊', nested: { enabled: false } },
};
async function persistence(): Promise<Persist> {
  const file = new URL(
    '../../../../src/storage/repositories/global-extension-config-persist.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Global extension SQL helper is unavailable');
  return (await import(file.href)).persistGlobalExtensionConfig;
}

describe('global extension configuration SQL extraction', () => {
  let db: Database;
  let store: ExternalEventExtensionConfigStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new ExternalEventExtensionConfigStore(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const row = () =>
    db.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(config.source);
  test('legacy updates retain creation time and exact JSON while clearing omitted options', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    await store.setGlobalConfig(config.source, config);
    expect(row()).toEqual({
      source: config.source,
      globally_enabled: 1,
      capabilities_json: '{"polling":true,"webhooks":false}',
      secrets_ref: config.secretsRef,
      settings_json: '{"label":"Synthetic 🦊","nested":{"enabled":false}}',
      created_at: 41,
      updated_at: 41,
    });
    clock.mockReturnValue(99);
    await store.setGlobalConfig(config.source, {
      source: config.source,
      globallyEnabled: false,
      capabilities: {},
    });
    expect(row()).toEqual({
      source: config.source,
      globally_enabled: 0,
      capabilities_json: '{}',
      secrets_ref: null,
      settings_json: '{}',
      created_at: 41,
      updated_at: 99,
    });
  });
  test('legacy validation rejects before clock or prepare and serialization failure writes nothing', async () => {
    const clock = vi.spyOn(Date, 'now');
    const prepare = vi.spyOn(db, 'prepare');
    await expect(store.setGlobalConfig(' wrong ', config)).rejects.toThrow('whitespace');
    await expect(store.setGlobalConfig('other', config)).rejects.toThrow('must match');
    await expect(
      store.setGlobalConfig(config.source, {
        ...config,
        settings: [] as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow('settings must be an object');
    expect(clock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      store.setGlobalConfig(config.source, {
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
  test('extracted statement has identical row results and bindings without consulting a clock', async () => {
    const persist = await persistence();
    const captures: unknown[][] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      const statement = prepare(...args);
      if (!args[0].includes('INSERT INTO external_event_extension_configs')) return statement;
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
    vi.spyOn(Date, 'now').mockReturnValue(41);
    await store.setGlobalConfig(config.source, config);
    const legacy = row();
    db.prepare('DELETE FROM external_event_extension_configs').run();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('helper must use caller time');
    });
    clock.mockClear();
    expect(persist(db, config.source, config, 41)).toBeUndefined();
    expect(clock).not.toHaveBeenCalled();
    expect(row()).toEqual(legacy);
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual(captures[1]);
    expect(captures[1]).toEqual([
      config.source,
      1,
      '{"polling":true,"webhooks":false}',
      'synthetic-reference',
      '{"label":"Synthetic 🦊","nested":{"enabled":false}}',
      41,
      41,
    ]);
  });
  test('extracted statement preserves caller rollback for insert and update', async () => {
    const persist = await persistence();
    expect(() =>
      db.transaction(() => {
        persist(db, config.source, config, 41);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(row()).toBeNull();
    persist(db, config.source, config, 41);
    const before = row();
    expect(() =>
      db.transaction(() => {
        persist(db, config.source, { ...config, globallyEnabled: false }, 99);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(row()).toEqual(before);
  });
  test('legacy setter retains clock, prepare, serialization and execution order', async () => {
    const events: string[] = [];
    vi.spyOn(Date, 'now').mockImplementation(() => {
      events.push('clock');
      return 41;
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((...args) => {
      events.push('prepare');
      return new Proxy(prepare(...args), {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...bindings: unknown[]) => {
            if (key === 'run') events.push('run');
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    });
    await store.setGlobalConfig(config.source, {
      ...config,
      capabilities: Object.assign(
        { polling: true },
        {
          toJSON() {
            events.push('capabilities');
            return { polling: true };
          },
        }
      ),
      settings: {
        toJSON() {
          events.push('settings');
          return { label: 'Synthetic 🦊' };
        },
      },
    });
    expect(events).toEqual(['clock', 'prepare', 'capabilities', 'settings', 'run']);
  });
});
