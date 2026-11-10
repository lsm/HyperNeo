import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { lookupGlobalExtensionConfig } from '../../../../src/storage/repositories/global-extension-config-lookup';
import type { ExternalEventExtensionConfig } from '../../../../src/lib/external-events/types';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';
const name = 'extension.global.config.read';
async function operation(): Promise<DbOp<{ source: string }, ExternalEventExtensionConfig>> {
  const path = new URL(
    '../../../../src/storage/repositories/global-extension-config-read.ts',
    import.meta.url
  );
  if (!existsSync(path)) throw new Error('Global config reader command unavailable');
  return (await import(path.href)).globalExtensionConfigReads;
}
class ControlledReader extends DbGateway {
  attempts = 0;
  rejectNext = false;
  held?: Promise<void>;
  afterRead?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== name) return super.run(op, args);
    this.attempts++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic config reader unavailable');
    }
    const result = await super.run(op, args);
    this.afterRead?.();
    await this.held;
    return result;
  }
}
describe('Global extension configuration reader command', () => {
  let db: Database, reader: ControlledReader;
  const source = 'synthetic-reader';
  const expected = {
    source,
    globallyEnabled: true,
    capabilities: { polling: true },
    secretsRef: 'synthetic/reference',
    settings: { label: 'Synthetic 🦊', nested: { off: false } },
  };
  beforeEach(() => {
    db = new Database(':memory:');
    createExternalEventConfigStore(db);
    reader = new ControlledReader(':memory:', db);
    db.prepare(
      'INSERT INTO external_event_extension_configs(source,globally_enabled,capabilities_json,secrets_ref,settings_json,created_at,updated_at)VALUES(?,?,?,?,?,1,1)'
    ).run(
      source,
      1,
      JSON.stringify(expected.capabilities),
      expected.secretsRef,
      JSON.stringify(expected.settings)
    );
  });
  afterEach(async () => {
    await reader.close();
    db.close();
  });
  const read = async (value = source) => reader.run(await operation(), { source: value });
  test('merged constructor-free helper characterizes the same complete data before command construction', () => {
    expect(lookupGlobalExtensionConfig(db, source)).toEqual(expected);
  });
  test('registered operation uses the existing read lane', async () => {
    const op = await operation();
    expect(op.mode).toBe('read');
    expect(DB_OPS.get(name)).toBe(op);
  });
  test('reader returns complete cloneable configuration for the requested source', async () => {
    expect(await read()).toEqual(expected);
    expect(structuredClone(await read())).toEqual(expected);
  });
  test('missing and malformed records preserve default and JSON fallback behavior', async () => {
    expect(await read('synthetic-missing')).toEqual({
      source: 'synthetic-missing',
      globallyEnabled: false,
      capabilities: {},
    });
    db.prepare(
      'UPDATE external_event_extension_configs SET capabilities_json=?,settings_json=? WHERE source=?'
    ).run('{', '[]', source);
    expect(await read()).toEqual({ ...expected, capabilities: {}, settings: {} });
  });
  test('reader failure propagates without fallback or automatic retry', async () => {
    reader.rejectNext = true;
    await expect(read()).rejects.toThrow('synthetic config reader unavailable');
    await new Promise((done) => setTimeout(done, 20));
    expect(reader.attempts).toBe(1);
    expect(await read()).toEqual(expected);
  });
  test('a held result retains its own snapshot and the next read sees committed changes', async () => {
    await operation();
    let signal!: () => void;
    const ready = new Promise<void>((done) => {
      signal = done;
    });
    reader.afterRead = signal;
    let release!: () => void;
    reader.held = new Promise<void>((done) => {
      release = done;
    });
    const pending = read();
    await Promise.race([ready, pending]);
    db.prepare('UPDATE external_event_extension_configs SET globally_enabled=0 WHERE source=?').run(
      source
    );
    reader.held = undefined;
    release();
    expect(await pending).toEqual(expected);
    expect(await read()).toEqual({ ...expected, globallyEnabled: false });
  });
});
