import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { persistSpaceExtensionConfig } from '../../../../src/storage/repositories/space-extension-config-persist';
import type { SpaceExternalEventSourceConfig } from '../../../../src/lib/external-events/types';

const name = 'extension.space.config.write';
type Args = { method: string; args: [string, string, SpaceExternalEventSourceConfig, number] };
const config: SpaceExternalEventSourceConfig = {
  spaceId: 'synthetic-one',
  source: 'github',
  enabled: true,
  settings: { label: 'Synthetic 🦊' },
};
async function operation(): Promise<DbOp<Args, void>> {
  const file = new URL(
    '../../../../src/storage/repositories/space-extension-config-write.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Space extension writer command is unavailable');
  return (await import(file.href)).spaceExtensionConfigWrites;
}
class FaultGateway extends DbGateway {
  calls = 0;
  rejectNext = false;
  loseNext = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== name) return super.run(op, args);
    this.calls++;
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
describe('Space extension writer command construction', () => {
  let db: Database;
  let store: ExternalEventExtensionConfigStore;
  let gateway: FaultGateway;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-one'),('synthetic-two')"
    );
    store = new ExternalEventExtensionConfigStore(db);
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const persist = async (value = config, now = 41) =>
    gateway.run(await operation(), {
      method: 'persist',
      args: [value.spaceId, value.source, value, now],
    });
  const row = () =>
    db
      .prepare('SELECT * FROM space_external_event_source_configs WHERE space_id=? AND source=?')
      .get(config.spaceId, config.source);
  test('merged helper retains exact JSON and supplied timestamps before command construction', () => {
    persistSpaceExtensionConfig(db, config.spaceId, config.source, config, 41);
    expect(row()).toEqual({
      space_id: config.spaceId,
      source: 'github',
      enabled: 1,
      settings_json: '{"label":"Synthetic 🦊"}',
      created_at: 41,
      updated_at: 41,
    });
  });
  test('registered write acknowledges committed updates without mixing Space/source keys', async () => {
    const op = await operation();
    expect(DB_OPS.get(name)).toBe(op);
    expect(op.mode).toBe('write');
    expect(await persist()).toBeUndefined();
    expect(await store.getSpaceConfig(config.spaceId, config.source)).toEqual(config);
    await persist({ ...config, spaceId: 'synthetic-two' }, 52);
    await persist({ ...config, source: 'synthetic-other' }, 63);
    await persist({ ...config, enabled: false, settings: {} }, 74);
    expect(row()).toEqual({
      space_id: config.spaceId,
      source: 'github',
      enabled: 0,
      settings_json: '{}',
      created_at: 41,
      updated_at: 74,
    });
    expect(await store.getSpaceConfig('synthetic-two', 'github')).toEqual({
      ...config,
      spaceId: 'synthetic-two',
    });
    expect(await store.getSpaceConfig(config.spaceId, 'synthetic-other')).toEqual({
      ...config,
      source: 'synthetic-other',
    });
  });
  test('post-statement failure rolls back both insertion and update', async () => {
    await operation();
    db.exec(
      "CREATE TRIGGER reject_synthetic_insert AFTER INSERT ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic rollback');END"
    );
    await expect(persist()).rejects.toThrow('synthetic rollback');
    expect(row()).toBeNull();
    db.exec('DROP TRIGGER reject_synthetic_insert');
    await persist();
    const before = row();
    db.exec(
      "CREATE TRIGGER reject_synthetic_update AFTER UPDATE ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic rollback');END"
    );
    await expect(persist({ ...config, enabled: false }, 99)).rejects.toThrow('synthetic rollback');
    expect(row()).toEqual(before);
  });
  test('foreign-key rejection leaves no orphan configuration', async () => {
    await operation();
    await expect(persist({ ...config, spaceId: 'synthetic-missing' })).rejects.toThrow(
      /FOREIGN KEY/i
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM space_external_event_source_configs').get()
    ).toEqual({ n: 0 });
  });
  test('admission failure leaves no row or automatic replay', async () => {
    await operation();
    gateway.rejectNext = true;
    await expect(persist()).rejects.toThrow('admission rejected');
    expect(row()).toBeNull();
    expect(gateway.calls).toBe(1);
  });
  test('lost post-commit acknowledgement is propagated without replay', async () => {
    await operation();
    gateway.loseNext = true;
    await expect(persist()).rejects.toThrow('outcome unknown');
    expect(await store.getSpaceConfig(config.spaceId, config.source)).toEqual(config);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
    expect(row()).toMatchObject({ created_at: 41, updated_at: 41 });
  });
});
