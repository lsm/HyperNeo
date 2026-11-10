import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import type { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { createExternalEventConfigStore } from '../../helpers/external-event-config-store';
class ControlledReader extends DbGateway {
  attempts = 0;
  rejectNext = false;
  loseNext = false;
  held?: Promise<void>;
  afterRead?: () => void;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'extension.global.config.read') return super.run(op, args);
    this.attempts++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic config reader unavailable');
    }
    const result = await super.run(op, args);
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error('synthetic completed reader reply lost');
    }
    this.afterRead?.();
    await this.held;
    return result;
  }
}
describe('Global extension configuration getter reader activation', () => {
  let db: Database, store: ExternalEventExtensionConfigStore, reader: ControlledReader;
  const source = 'synthetic-reader-activation',
    expected = {
      source,
      globallyEnabled: true,
      capabilities: { polling: true },
      secretsRef: 'synthetic/reference',
      settings: { label: 'Synthetic 🦊' },
    };
  beforeEach(() => {
    db = new Database(':memory:');
    store = createExternalEventConfigStore(db);
    reader = new ControlledReader(':memory:', db);
    bindGateway(db, reader);
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
    vi.restoreAllMocks();
  });
  test('bound getter waits for the reader reply and preserves its complete result', async () => {
    let release!: () => void,
      signal!: () => void,
      settled = false;
    reader.held = new Promise<void>((done) => {
      release = done;
    });
    const ready = new Promise<void>((done) => {
      signal = done;
    });
    reader.afterRead = signal;
    const pending = store.getGlobalConfig(source).finally(() => {
      settled = true;
    });
    await Promise.race([ready, pending]);
    const beforeReceipt = { attempts: reader.attempts, settled };
    release();
    const result = await pending;
    expect(beforeReceipt).toEqual({ attempts: 1, settled: false });
    expect(result).toEqual(expected);
  });
  test('validation rejects before any reader admission or SQL', async () => {
    const prepare = vi.spyOn(db, 'prepare');
    await expect(store.getGlobalConfig(' bad ')).rejects.toThrow('whitespace');
    await expect(store.getGlobalConfig('')).rejects.toThrow('non-empty');
    expect(reader.attempts).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
  test('admission failure propagates without main fallback or automatic retry', async () => {
    reader.rejectNext = true;
    await expect(store.getGlobalConfig(source)).rejects.toThrow(
      'synthetic config reader unavailable'
    );
    await new Promise((done) => setTimeout(done, 20));
    expect(reader.attempts).toBe(1);
    expect(await store.getGlobalConfig(source)).toEqual(expected);
  });
  test('completed reply loss propagates and an independent getter can recover', async () => {
    reader.loseNext = true;
    await expect(store.getGlobalConfig(source)).rejects.toThrow('completed reader reply lost');
    await new Promise((done) => setTimeout(done, 20));
    expect(reader.attempts).toBe(1);
    expect(await store.getGlobalConfig(source)).toEqual(expected);
  });
});
