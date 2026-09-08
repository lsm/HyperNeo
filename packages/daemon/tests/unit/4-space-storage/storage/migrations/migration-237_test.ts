import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration237 } from '../../../../../src/storage/schema/m237-task-reconcile-watermark.ts';

function createSpaceTasksTable(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      workflow_run_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('Migration 237: space_tasks.reconcile_checked_at watermark', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTasksTable(db);
  });

  afterEach(() => {
    db.close();
  });

  test('adds the reconcile watermark column', () => {
    runMigration237(db);

    const columns = (
      db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(columns).toContain('reconcile_checked_at');
  });

  test('is idempotent', () => {
    runMigration237(db);
    runMigration237(db);

    const matches = (
      db.prepare(`PRAGMA table_info(space_tasks)`).all() as Array<{
        name: string;
      }>
    ).filter((row) => row.name === 'reconcile_checked_at');
    expect(matches).toHaveLength(1);
  });

  test('is a no-op when space_tasks does not exist', () => {
    const fresh = new BunDatabase(':memory:');
    try {
      runMigration237(fresh);

      const tables = fresh
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_tasks'`)
        .all();
      expect(tables).toHaveLength(0);
    } finally {
      fresh.close();
    }
  });
});
