import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

async function lookup() {
  const path = new URL(
    '../../../../src/storage/repositories/space-extension-config-lookup.ts',
    import.meta.url
  );
  if (!existsSync(path)) throw new Error('Constructor-free Space config queries unavailable');
  return await import(path.href);
}
describe('Space extension configuration query extraction', () => {
  let db: Database, store: ExternalEventExtensionConfigStore;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('a'),('b'),('c'),('d')"
    );
    store = createExternalEventConfigStore(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const seed = (space: string, source: string, enabled: number, settings: string) =>
    db
      .prepare(
        'INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,?,?,1,1)'
      )
      .run(space, source, enabled, settings);
  test('missing rows remain null and complete configurations retain compound-key isolation', async () => {
    seed('a', 'github', 1, '{"label":"Synthetic 🦊","nested":{"off":false}}');
    seed('b', 'github', 0, '{}');
    seed('a', 'other', 0, '{"other":true}');
    const expected = {
      spaceId: 'a',
      source: 'github',
      enabled: true,
      settings: { label: 'Synthetic 🦊', nested: { off: false } },
    };
    expect(await store.getSpaceConfig('a', 'github')).toEqual(expected);
    expect(await store.getSpaceConfig('missing', 'github')).toBeNull();
    const { lookupSpaceExtensionConfig } = await lookup();
    expect(lookupSpaceExtensionConfig(db, 'a', 'github')).toEqual(expected);
    expect(lookupSpaceExtensionConfig(db, 'a', 'other')).toEqual({
      spaceId: 'a',
      source: 'other',
      enabled: false,
      settings: { other: true },
    });
    expect(lookupSpaceExtensionConfig(db, 'missing', 'github')).toBeNull();
  });
  test('enabled lists sort by Space id and isolate source and strict enabled flags', async () => {
    seed('c', 'github', 1, '{"n":3}');
    seed('a', 'github', 1, '{"n":1}');
    seed('b', 'github', 0, '{}');
    seed('d', 'github', 2, '{}');
    seed('b', 'other', 1, '{}');
    const expected = [
      { spaceId: 'a', source: 'github', enabled: true, settings: { n: 1 } },
      { spaceId: 'c', source: 'github', enabled: true, settings: { n: 3 } },
    ];
    expect(await store.listEnabledSpaces('github')).toEqual(expected);
    const { listEnabledSpaceExtensionConfigs, lookupSpaceExtensionConfig } = await lookup();
    expect(listEnabledSpaceExtensionConfigs(db, 'github')).toEqual(expected);
    expect(listEnabledSpaceExtensionConfigs(db, 'missing')).toEqual([]);
    expect(lookupSpaceExtensionConfig(db, 'd', 'github').enabled).toBe(false);
  });
  test('malformed and non-object JSON retain fresh object fallbacks', async () => {
    const { lookupSpaceExtensionConfig } = await lookup();
    for (const [index, settings] of ['{', '[]', 'null', '42', '"text"'].entries()) {
      const source = 'synthetic-' + index;
      seed('a', source, 1, settings);
      const expected = { spaceId: 'a', source, enabled: true, settings: {} };
      expect(await store.getSpaceConfig('a', source)).toEqual(expected);
      const first = lookupSpaceExtensionConfig(db, 'a', source);
      expect(first).toEqual(expected);
      first.settings.changed = true;
      expect(lookupSpaceExtensionConfig(db, 'a', source)).toEqual(expected);
    }
  });
  test('queries use the supplied connection and see caller-owned changes that roll back', async () => {
    seed('a', 'github', 0, '{}');
    const { lookupSpaceExtensionConfig, listEnabledSpaceExtensionConfigs } = await lookup();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          'UPDATE space_external_event_source_configs SET enabled=1,settings_json=? WHERE space_id=? AND source=?'
        ).run('{"pending":true}', 'a', 'github');
        expect(lookupSpaceExtensionConfig(db, 'a', 'github')).toEqual({
          spaceId: 'a',
          source: 'github',
          enabled: true,
          settings: { pending: true },
        });
        expect(listEnabledSpaceExtensionConfigs(db, 'github')).toEqual([
          lookupSpaceExtensionConfig(db, 'a', 'github'),
        ]);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(lookupSpaceExtensionConfig(db, 'a', 'github')).toEqual({
      spaceId: 'a',
      source: 'github',
      enabled: false,
      settings: {},
    });
    expect(listEnabledSpaceExtensionConfigs(db, 'github')).toEqual([]);
  });
  test('store validation rejects before either query', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    await expect(store.getSpaceConfig(' bad ', 'github')).rejects.toThrow('Space id');
    await expect(store.getSpaceConfig('a', ' bad ')).rejects.toThrow('External event source');
    await expect(store.listEnabledSpaces('')).rejects.toThrow('non-empty');
    expect(prepare).not.toHaveBeenCalled();
  });
});
