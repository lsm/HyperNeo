import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import {
  lookupSpaceExtensionConfig,
  listEnabledSpaceExtensionConfigs,
} from '../../../../src/storage/repositories/space-extension-config-lookup';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';
const names = ['extension.space.config.read', 'extension.space.enabled.read'];
async function operations() {
  const path = new URL(
    '../../../../src/storage/repositories/space-extension-config-read.ts',
    import.meta.url
  );
  if (!existsSync(path)) throw new Error('Space config reader commands unavailable');
  return await import(path.href);
}
class ControlledReader extends DbGateway {
  attempts = 0;
  rejectNext = false;
  held?: Promise<void>;
  afterRead?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (!names.includes(op.name)) return super.run(op, args);
    this.attempts++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic Space reader unavailable');
    }
    const result = await super.run(op, args);
    this.afterRead?.();
    await this.held;
    return result;
  }
}
describe('Space extension configuration reader construction', () => {
  let db: Database, reader: ControlledReader;
  const source = 'github',
    spaceId = 'synthetic-a',
    expected = {
      spaceId,
      source,
      enabled: true,
      settings: { label: 'Synthetic 🦊', nested: { off: false } },
    };
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-a'),('synthetic-b'),('synthetic-c')"
    );
    createExternalEventConfigStore(db);
    reader = new ControlledReader(':memory:', db);
    for (const [id, origin, enabled, settings] of [
      [spaceId, source, 1, JSON.stringify(expected.settings)],
      ['synthetic-b', source, 0, '{'],
      ['synthetic-c', source, 1, '[]'],
      [spaceId, 'other', 1, '{}'],
    ])
      db.prepare(
        'INSERT INTO space_external_event_source_configs(space_id,source,enabled,settings_json,created_at,updated_at)VALUES(?,?,?,?,1,1)'
      ).run(id, origin, enabled, settings);
  });
  afterEach(async () => {
    await reader.close();
    db.close();
  });
  const get = async (id = spaceId, origin = source) =>
    reader.run((await operations()).spaceExtensionConfigReads, { spaceId: id, source: origin });
  const list = async (origin = source) =>
    reader.run((await operations()).enabledSpaceExtensionConfigReads, { source: origin });
  test('merged query helpers characterize results before reader construction', () => {
    expect(lookupSpaceExtensionConfig(db, spaceId, source)).toEqual(expected);
    expect(listEnabledSpaceExtensionConfigs(db, source).map((row) => row.spaceId)).toEqual([
      spaceId,
      'synthetic-c',
    ]);
  });
  test('both operations are registered read-only commands', async () => {
    const { spaceExtensionConfigReads, enabledSpaceExtensionConfigReads } = await operations();
    for (const [i, op] of [spaceExtensionConfigReads, enabledSpaceExtensionConfigReads].entries()) {
      expect(op.name).toBe(names[i]);
      expect(op.mode).toBe('read');
      expect(DB_OPS.get(names[i])).toBe(op);
    }
  });
  test('complete records, compound keys, missing values and JSON fallbacks survive cloneable replies', async () => {
    expect(await get()).toEqual(expected);
    expect(structuredClone(await get())).toEqual(expected);
    expect(await get('missing')).toBeNull();
    expect(await get(spaceId, 'other')).toEqual({ ...expected, source: 'other', settings: {} });
    expect(await get('synthetic-b')).toEqual({
      spaceId: 'synthetic-b',
      source,
      enabled: false,
      settings: {},
    });
    expect(await list()).toEqual([
      expected,
      { spaceId: 'synthetic-c', source, enabled: true, settings: {} },
    ]);
    expect(await list('missing')).toEqual([]);
  });
  test('either reader failure rejects without fallback or automatic retry', async () => {
    await operations();
    for (const read of [get, list]) {
      const before = reader.attempts;
      reader.rejectNext = true;
      await expect(read()).rejects.toThrow('synthetic Space reader unavailable');
      await new Promise((done) => setTimeout(done, 20));
      expect(reader.attempts).toBe(before + 1);
    }
    expect(await get()).toEqual(expected);
    expect((await list()).length).toBe(2);
  });
  test('held get and list results retain their snapshot while subsequent reads see a commit', async () => {
    await operations();
    let release!: () => void, signal!: () => void;
    let completed = 0;
    const ready = new Promise<void>((done) => {
      signal = done;
    });
    reader.held = new Promise<void>((done) => {
      release = done;
    });
    reader.afterRead = () => {
      if (++completed === 2) signal();
    };
    const pendingGet = get(),
      pendingList = list();
    await Promise.race([ready, Promise.all([pendingGet, pendingList])]);
    db.prepare(
      'UPDATE space_external_event_source_configs SET enabled=0 WHERE space_id=? AND source=?'
    ).run(spaceId, source);
    reader.held = undefined;
    release();
    expect(await pendingGet).toEqual(expected);
    expect(await pendingList).toEqual([
      expected,
      { spaceId: 'synthetic-c', source, enabled: true, settings: {} },
    ]);
    expect(await get()).toEqual({ ...expected, enabled: false });
    expect((await list()).map((row) => row.spaceId)).toEqual(['synthetic-c']);
  });
});
