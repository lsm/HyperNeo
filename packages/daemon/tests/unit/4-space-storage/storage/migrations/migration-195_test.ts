import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration195 } from '../../../../../src/storage/schema/migrations.ts';

const SPACE_ID = 'space-migration-195';

function insertSpace(db: BunDatabase): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, `Space ${SPACE_ID}`, SPACE_ID, Date.now(), Date.now());
}

let taskNumberSeq = 0;

function insertTask(db: BunDatabase, id: string, status: string, result: string | null): void {
  taskNumberSeq += 1;
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, task_number, title, description, status, result, created_at, updated_at)
     VALUES (?, ?, ?, 'T', '', ?, ?, ?, ?)`
  ).run(id, SPACE_ID, taskNumberSeq, status, result, Date.now(), Date.now());
}

function tableSql(db: BunDatabase): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
    .get() as { sql: string } | null;
  return row?.sql ?? '';
}

function setStatus(db: BunDatabase, id: string, status: string): void {
  db.prepare(`UPDATE space_tasks SET status = ? WHERE id = ?`).run(status, id);
}

describe('Migration 195: space_tasks status CHECK includes stopped', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(
      process.cwd(),
      'tmp',
      'test-migration-195',
      `test-${Date.now()}-${Math.random()}`
    );
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('fresh DB — full migration chain accepts stopped', () => {
    runMigrations(db, () => {});
    insertSpace(db);
    insertTask(db, 't-1', 'open', null);
    expect(() => setStatus(db, 't-1', 'stopped')).not.toThrow();
    expect(tableSql(db)).toContain("'stopped'");
  });

  test('upgraded DB — pre-195 schema rejects stopped, migration opens it and preserves rows', () => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
    );
    db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES ('migration_195', ?)`).run(
      Date.now()
    );
    runMigrations(db, () => {});
    expect(tableSql(db)).not.toContain("'stopped'");

    insertSpace(db);
    insertTask(db, 't-1', 'open', null);
    insertTask(db, 't-2', 'in_progress', 'partial work');
    expect(() => setStatus(db, 't-1', 'stopped')).toThrow();

    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_195'`).run();
    runMigrations(db, () => {});

    expect(tableSql(db)).toContain("'stopped'");
    expect(() => setStatus(db, 't-1', 'stopped')).not.toThrow();
    const rows = db
      .prepare(`SELECT id, status, result FROM space_tasks ORDER BY id`)
      .all() as Array<{ id: string; status: string; result: string | null }>;
    expect(rows).toEqual([
      { id: 't-1', status: 'stopped', result: null },
      { id: 't-2', status: 'in_progress', result: 'partial work' },
    ]);
  });

  test('upgraded DB — columns and indexes survive the rebuild', () => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`
    );
    db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES ('migration_195', ?)`).run(
      Date.now()
    );
    runMigrations(db, () => {});
    const beforeColumns = (
      db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const beforeIndexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='space_tasks'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);

    db.prepare(`DELETE FROM migration_markers WHERE key = 'migration_195'`).run();
    runMigrations(db, () => {});

    const afterColumns = (
      db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const afterIndexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='space_tasks'`)
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(afterColumns.sort()).toEqual(beforeColumns.sort());
    expect(afterIndexes.sort()).toEqual(beforeIndexes.sort());
  });

  test('CHECK constraint still rejects unknown statuses after migration', () => {
    runMigrations(db, () => {});
    insertSpace(db);
    insertTask(db, 't-1', 'open', null);
    expect(() => setStatus(db, 't-1', 'bogus_status')).toThrow();
  });

  test('runMigration195 is idempotent — running twice does not error', () => {
    runMigrations(db, () => {});
    insertSpace(db);
    insertTask(db, 't-1', 'stopped', 'parked');
    expect(() => runMigration195(db)).not.toThrow();
    const row = db.prepare(`SELECT status, result FROM space_tasks WHERE id = 't-1'`).get() as {
      status: string;
      result: string | null;
    };
    expect(row).toEqual({ status: 'stopped', result: 'parked' });
  });

  test('no-op when space_tasks does not exist', () => {
    expect(() => runMigration195(db)).not.toThrow();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='space_tasks'`)
      .get();
    expect(row).toBeNull();
  });
});
