import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import type { ExternalEventExtensionConfig } from '../../../../src/lib/external-events/types';

class ControlledGateway extends DbGateway {
  calls = 0;
  held: Promise<void> | undefined;
  rejectNext = false;
  loseNext = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'extension.global.config.write') return super.run(op, args);
    this.calls++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic admission rejected');
    }
    await this.held;
    const result = await super.run(op, args);
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error('synthetic committed reply lost; outcome unknown');
    }
    return result;
  }
}
const config: ExternalEventExtensionConfig = {
  source: 'synthetic-extension',
  globallyEnabled: true,
  capabilities: { polling: true },
  settings: { label: 'Synthetic 🦊' },
};
describe('global extension setter writer activation', () => {
  let db: Database;
  let store: ExternalEventExtensionConfigStore;
  let gateway: ControlledGateway;
  beforeEach(() => {
    db = new Database(':memory:');
    gateway = new ControlledGateway(':memory:', db);
    bindGateway(db, gateway);
    store = new ExternalEventExtensionConfigStore(db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
    vi.restoreAllMocks();
  });
  const row = () =>
    db.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(config.source);
  test('bound setter waits for writer receipt and retains pre-admission clock', async () => {
    let release!: () => void;
    gateway.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(41);
    let settled = false;
    const pending = store.setGlobalConfig(config.source, config).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    const beforeReceipt = row();
    clock.mockReturnValue(99);
    release();
    await pending;
    expect(beforeReceipt).toBeNull();
    expect(settled).toBe(true);
    expect(gateway.calls).toBe(1);
    expect(row()).toMatchObject({ created_at: 41, updated_at: 41 });
  });
  test('validation rejects before clock or command admission', async () => {
    const clock = vi.spyOn(Date, 'now');
    await expect(store.setGlobalConfig(' wrong ', config)).rejects.toThrow('whitespace');
    await expect(store.setGlobalConfig('other', config)).rejects.toThrow('must match');
    expect(clock).not.toHaveBeenCalled();
    expect(gateway.calls).toBe(0);
    expect(row()).toBeNull();
  });
  test('admission rejection propagates without local fallback or replay', async () => {
    gateway.rejectNext = true;
    await expect(store.setGlobalConfig(config.source, config)).rejects.toThrow(
      'admission rejected'
    );
    expect(row()).toBeNull();
    expect(gateway.calls).toBe(1);
  });
  test('a committed unknown outcome is propagated without replay', async () => {
    gateway.loseNext = true;
    await expect(store.setGlobalConfig(config.source, config)).rejects.toThrow('outcome unknown');
    expect(await store.getGlobalConfig(config.source)).toEqual(config);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
});
