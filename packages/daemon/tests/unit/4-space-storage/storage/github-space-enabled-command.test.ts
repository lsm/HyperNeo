import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import type { SpaceExternalEventSourceConfig } from '../../../../src/lib/external-events/types';
import { createWatchedTable, insertWatchedRow } from '../../helpers/github-watched-read-fixture';

const name = 'github.space.enabled.write';
type Args = { method: string; args: [string, boolean, number] };
type Receipt = { changedRows: number; config: SpaceExternalEventSourceConfig };
async function operation(): Promise<DbOp<Args, Receipt>> {
  const file = new URL(
    '../../../../src/storage/repositories/github-space-enabled-write.ts',
    import.meta.url
  );
  if (!existsSync(file)) throw new Error('Atomic GitHub Space enabled writer is unavailable');
  return (await import(file.href)).gitHubSpaceEnabledWrites;
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
describe('atomic GitHub Space enabled writer construction', () => {
  let db: Database;
  let gateway: FaultGateway;
  let store: ExternalEventExtensionConfigStore;
  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE spaces(id TEXT PRIMARY KEY);INSERT INTO spaces VALUES('synthetic-one'),('synthetic-two'),('synthetic-empty');CREATE TABLE space_github_source_settings(space_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,polling_intent INTEGER NOT NULL DEFAULT 0,filter_current_user INTEGER NOT NULL DEFAULT 1);INSERT INTO space_github_source_settings VALUES('synthetic-one',0,11,12,1,0),('synthetic-two',1,21,22,0,1)"
    );
    createWatchedTable(db);
    insertWatchedRow(db, { space_id: 'synthetic-one', enabled: 0 });
    insertWatchedRow(db, {
      id: 'synthetic-next',
      space_id: 'synthetic-one',
      repo: 'repo-next',
      enabled: 0,
    });
    insertWatchedRow(db, { id: 'synthetic-other', space_id: 'synthetic-two' });
    store = new ExternalEventExtensionConfigStore(db);
    await store.setSpaceConfig('synthetic-one', 'github', {
      spaceId: 'synthetic-one',
      source: 'github',
      enabled: false,
      settings: { baseline: true },
    });
    db.exec('UPDATE space_external_event_source_configs SET created_at=13,updated_at=14');
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
  });
  const persist = async (enabled = true, now = 41, spaceId = 'synthetic-one') =>
    gateway.run(await operation(), { method: 'persist', args: [spaceId, enabled, now] });
  const state = () => ({
    source: db.prepare('SELECT * FROM space_github_source_settings ORDER BY space_id').all(),
    watched: db.prepare('SELECT * FROM space_github_watched_repos ORDER BY id').all(),
    config: db
      .prepare('SELECT * FROM space_external_event_source_configs ORDER BY space_id,source')
      .all(),
  });
  const sourceRow = () =>
    db.prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-one'").get();
  test('registered write returns committed snapshot/count with shared supplied time and unchanged creation times', async () => {
    const op = await operation();
    expect(DB_OPS.get(name)).toBe(op);
    expect(op.mode).toBe('write');
    const other = db
      .prepare("SELECT * FROM space_github_watched_repos WHERE space_id='synthetic-two'")
      .all();
    const otherSource = db
      .prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-two'")
      .get();
    const receipt = await persist();
    expect(receipt.changedRows).toBe(2);
    expect(receipt.config).toEqual(await store.getSpaceConfig('synthetic-one', 'github'));
    expect(receipt.config).toMatchObject({
      enabled: true,
      settings: { pollingIntent: true, filterCurrentUser: false },
    });
    expect(receipt.config.settings.watchedRepos).toHaveLength(2);
    expect(JSON.stringify(receipt.config)).not.toContain('synthetic-webhook-only');
    expect(JSON.stringify(receipt.config)).not.toContain('synthetic-etag');
    expect(sourceRow()).toMatchObject({
      enabled: 1,
      created_at: 11,
      updated_at: 41,
      polling_intent: 1,
      filter_current_user: 0,
    });
    expect(
      db.prepare('SELECT created_at,updated_at FROM space_external_event_source_configs').get()
    ).toEqual({ created_at: 13, updated_at: 41 });
    expect(
      db
        .prepare(
          "SELECT enabled,updated_at FROM space_github_watched_repos WHERE space_id='synthetic-one'"
        )
        .all()
    ).toEqual([
      { enabled: 1, updated_at: 41 },
      { enabled: 1, updated_at: 41 },
    ]);
    expect(
      db.prepare("SELECT * FROM space_github_watched_repos WHERE space_id='synthetic-two'").all()
    ).toEqual(other);
    expect(
      db.prepare("SELECT * FROM space_github_source_settings WHERE space_id='synthetic-two'").get()
    ).toEqual(otherSource);
    const disabled = await persist(false, 52);
    expect(disabled.changedRows).toBe(2);
    expect(disabled.config.enabled).toBe(false);
    expect(disabled.config).toEqual(await store.getSpaceConfig('synthetic-one', 'github'));
    expect(sourceRow()).toMatchObject({ enabled: 0, created_at: 11, updated_at: 52 });
    expect((await persist(false, 63)).changedRows).toBe(2);
  });
  test('empty Space stores defaults and returns zero watched changes without touching existing Spaces', async () => {
    const before = state();
    const receipt = await persist(false, 71, 'synthetic-empty');
    expect(receipt).toEqual({
      changedRows: 0,
      config: {
        spaceId: 'synthetic-empty',
        source: 'github',
        enabled: false,
        settings: { pollingIntent: false, filterCurrentUser: true, watchedRepos: [] },
      },
    });
    expect(
      db
        .prepare(
          "SELECT created_at,updated_at FROM space_github_source_settings WHERE space_id='synthetic-empty'"
        )
        .get()
    ).toEqual({ created_at: 71, updated_at: 71 });
    expect(
      db
        .prepare(
          "SELECT created_at,updated_at FROM space_external_event_source_configs WHERE space_id='synthetic-empty'"
        )
        .get()
    ).toEqual({ created_at: 71, updated_at: 71 });
    expect(state().watched).toEqual(before.watched);
    expect(sourceRow()).toMatchObject({ enabled: 0, updated_at: 12 });
  });
  test('snapshot failure rolls back source, watched flags and saved configuration together', async () => {
    await operation();
    const before = state();
    db.exec(
      "CREATE TRIGGER reject_synthetic_snapshot AFTER UPDATE ON space_external_event_source_configs BEGIN SELECT RAISE(ABORT,'synthetic snapshot failure');END"
    );
    await expect(persist()).rejects.toThrow('synthetic snapshot failure');
    expect(state()).toEqual(before);
  });
  test('malformed cursor failure and orphan rejection leave no partial source or watched update', async () => {
    await operation();
    db.prepare('UPDATE space_github_watched_repos SET poll_cursor=? WHERE id=?').run(
      '{broken',
      'synthetic-one'
    );
    const before = state();
    await expect(persist()).rejects.toThrow(SyntaxError);
    expect(state()).toEqual(before);
    await expect(persist(true, 81, 'synthetic-missing')).rejects.toThrow(/FOREIGN KEY/i);
    expect(state()).toEqual(before);
  });
  test('invalid Space ids retain the existing validation error without writes', async () => {
    await operation();
    const before = state();
    for (const spaceId of ['', ' ', ' synthetic-one', 'synthetic-one '])
      await expect(persist(true, 41, spaceId)).rejects.toThrow(
        'Space id must be non-empty and must not include edge whitespace'
      );
    expect(state()).toEqual(before);
  });
  test('admission failure does not write or replay', async () => {
    await operation();
    const before = state();
    gateway.rejectNext = true;
    await expect(persist()).rejects.toThrow('admission rejected');
    expect(state()).toEqual(before);
    expect(gateway.calls).toBe(1);
  });
  test('lost committed acknowledgement propagates while retaining one atomic snapshot without replay', async () => {
    await operation();
    gateway.loseNext = true;
    await expect(persist()).rejects.toThrow('outcome unknown');
    const config = await store.getSpaceConfig('synthetic-one', 'github');
    expect(config).toMatchObject({
      enabled: true,
      settings: { pollingIntent: true, filterCurrentUser: false },
    });
    expect(sourceRow()).toMatchObject({ enabled: 1, updated_at: 41 });
    expect(
      db
        .prepare(
          "SELECT enabled,updated_at FROM space_github_watched_repos WHERE space_id='synthetic-one'"
        )
        .all()
    ).toEqual([
      { enabled: 1, updated_at: 41 },
      { enabled: 1, updated_at: 41 },
    ]);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.calls).toBe(1);
  });
});
