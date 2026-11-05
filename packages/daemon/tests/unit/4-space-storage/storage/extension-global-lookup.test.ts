import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';

async function lookup() {
  const path = new URL(
    '../../../../src/storage/repositories/global-extension-config-lookup.ts',
    import.meta.url
  );
  if (!existsSync(path)) throw new Error('Constructor-free global config lookup unavailable');
  return (await import(path.href)).lookupGlobalExtensionConfig;
}
describe('Global extension configuration lookup extraction', () => {
  let db: Database, store: ExternalEventExtensionConfigStore;
  beforeEach(() => {
    db = new Database(':memory:');
    store = createExternalEventConfigStore(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });
  const seed = (
    source: string,
    enabled: number,
    capabilities: string,
    settings: string | null,
    secret: string | null = null
  ) =>
    db
      .prepare(
        'INSERT INTO external_event_extension_configs(source,globally_enabled,capabilities_json,secrets_ref,settings_json,created_at,updated_at)VALUES(?,?,?,?,?,1,1)'
      )
      .run(source, enabled, capabilities, secret, settings);
  test('missing rows return fresh disabled defaults for the exact requested source', async () => {
    const read = await lookup();
    const expected = { source: 'synthetic-missing', globallyEnabled: false, capabilities: {} };
    expect(await store.getGlobalConfig(expected.source)).toEqual(expected);
    const first = read(db, expected.source);
    expect(first).toEqual(expected);
    first.capabilities.polling = true;
    expect(read(db, expected.source)).toEqual(expected);
  });
  test('full nested JSON and optional fields preserve the legacy public values', async () => {
    seed(
      'synthetic-one',
      1,
      '{"polling":true,"extra":{"preserved":1}}',
      '{"label":"Synthetic 🦊","nested":{"off":false}}',
      'synthetic/reference'
    );
    seed('synthetic-other', 0, '{}', null);
    const expected = {
      source: 'synthetic-one',
      globallyEnabled: true,
      capabilities: { polling: true, extra: { preserved: 1 } },
      secretsRef: 'synthetic/reference',
      settings: { label: 'Synthetic 🦊', nested: { off: false } },
    };
    expect(await store.getGlobalConfig('synthetic-one')).toEqual(expected);
    const read = await lookup();
    expect(read(db, 'synthetic-one')).toEqual(expected);
    expect(structuredClone(read(db, 'synthetic-one'))).toEqual(expected);
    expect(read(db, 'synthetic-other')).toEqual({
      source: 'synthetic-other',
      globallyEnabled: false,
      capabilities: {},
    });
  });
  test('malformed JSON and non-object JSON retain the object fallback and nullable fields', async () => {
    seed('synthetic-invalid', 2, '{', '[]', '');
    seed('synthetic-null', 0, 'null', null);
    seed('synthetic-primitive', 0, '42', '"text"');
    const read = await lookup();
    for (const source of ['synthetic-invalid', 'synthetic-null', 'synthetic-primitive']) {
      const expected = {
        source,
        globallyEnabled: false,
        capabilities: {},
        ...(source === 'synthetic-invalid' ? { secretsRef: '' } : {}),
        ...(source === 'synthetic-null' ? {} : { settings: {} }),
      };
      expect(await store.getGlobalConfig(source)).toEqual(expected);
      expect(read(db, source)).toEqual(expected);
    }
  });
  test('the lookup uses its supplied connection and preserves caller transaction rollback', async () => {
    seed('synthetic-tx', 0, '{}', null);
    const read = await lookup();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          'UPDATE external_event_extension_configs SET globally_enabled=1 WHERE source=?'
        ).run('synthetic-tx');
        expect(read(db, 'synthetic-tx').globallyEnabled).toBe(true);
        throw new Error('synthetic rollback');
      })()
    ).toThrow('synthetic rollback');
    expect(read(db, 'synthetic-tx').globallyEnabled).toBe(false);
  });
  test('the public store rejects invalid source ids before querying', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    await expect(store.getGlobalConfig(' bad ')).rejects.toThrow('whitespace');
    await expect(store.getGlobalConfig('')).rejects.toThrow('non-empty');
    expect(prepare).not.toHaveBeenCalled();
  });
});
