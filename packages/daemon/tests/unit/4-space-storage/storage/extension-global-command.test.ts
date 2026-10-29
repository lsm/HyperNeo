import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { persistGlobalExtensionConfig } from '../../../../src/storage/repositories/global-extension-config-persist';
import type { ExternalEventExtensionConfig } from '../../../../src/lib/external-events/types';

const name = 'extension.global.config.write';
type Args = { method: string; args: [string, ExternalEventExtensionConfig, number] };
const config: ExternalEventExtensionConfig = {
  source: 'synthetic-extension',
  globallyEnabled: true,
  capabilities: { polling: true },
  settings: { label: 'Synthetic 🦊' },
};
async function operation(): Promise<DbOp<Args, void>> {
  const file = new URL(
    '../../../../src/storage/repositories/global-extension-config-write.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Global extension writer command is unavailable');
  return (await import(file.href)).globalExtensionConfigWrites;
}
class FaultGateway extends DbGateway {
  commands = 0;
  rejectNext = false;
  loseNext = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== name) return super.run(op, args);
    this.commands++;
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error('synthetic admission rejected');
    }
    const result = await super.run(op, args);
    if (this.loseNext) {
      this.loseNext = false;
      throw new Error('synthetic committed reply lost; outcome unknown');
    }
    return result;
  }
}
describe('global extension writer command construction', () => {
  let db: Database;
  let store: ExternalEventExtensionConfigStore;
  let gateway: FaultGateway;
  beforeEach(() => {
    db = new Database(':memory:');
    store = new ExternalEventExtensionConfigStore(db);
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const persist = async (value = config, now = 41) =>
    gateway.run(await operation(), { method: 'persist', args: [value.source, value, now] });
  const row = () =>
    db.prepare('SELECT * FROM external_event_extension_configs WHERE source=?').get(config.source);
  test('merged helper preserves literal JSON and supplied time before command construction', () => {
    persistGlobalExtensionConfig(db, config.source, config, 41);
    expect(row()).toMatchObject({
      capabilities_json: '{"polling":true}',
      settings_json: '{"label":"Synthetic 🦊"}',
      created_at: 41,
      updated_at: 41,
    });
  });
  test('registered write acknowledges a committed row and retains creation time across updates', async () => {
    const op = await operation();
    expect(DB_OPS.get(name)).toBe(op);
    expect(op.mode).toBe('write');
    expect(await persist()).toBeUndefined();
    expect(await store.getGlobalConfig(config.source)).toEqual({
      ...config,
      settings: config.settings,
    });
    expect(
      await persist({ source: config.source, globallyEnabled: false, capabilities: {} }, 99)
    ).toBeUndefined();
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
  test('post-statement failure rolls back inserts and existing updates atomically', async () => {
    const op = await operation();
    const execute = (now: number) =>
      gateway.run(op, { method: 'persist', args: [config.source, config, now] });
    db.exec(
      "CREATE TRIGGER reject_synthetic_config_insert AFTER INSERT ON external_event_extension_configs BEGIN SELECT RAISE(ABORT,'synthetic rollback');END"
    );
    await expect(execute(41)).rejects.toThrow('synthetic rollback');
    expect(row()).toBeNull();
    db.exec('DROP TRIGGER reject_synthetic_config_insert');
    await execute(41);
    const before = row();
    db.exec(
      "CREATE TRIGGER reject_synthetic_config_update AFTER UPDATE ON external_event_extension_configs BEGIN SELECT RAISE(ABORT,'synthetic rollback');END"
    );
    await expect(execute(99)).rejects.toThrow('synthetic rollback');
    expect(row()).toEqual(before);
  });
  test('admission rejection leaves no row and does not replay', async () => {
    await operation();
    gateway.rejectNext = true;
    await expect(persist()).rejects.toThrow('admission rejected');
    expect(row()).toBeNull();
    expect(gateway.commands).toBe(1);
  });
  test('lost post-commit acknowledgement is not replayed automatically', async () => {
    await operation();
    gateway.loseNext = true;
    await expect(persist()).rejects.toThrow('outcome unknown');
    expect(await store.getGlobalConfig(config.source)).toEqual(config);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.commands).toBe(1);
    expect(row()).toMatchObject({ created_at: 41, updated_at: 41 });
  });
});
