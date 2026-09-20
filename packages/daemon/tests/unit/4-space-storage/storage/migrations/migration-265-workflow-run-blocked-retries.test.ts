import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration265 } from '../../../../../src/storage/schema/index.ts';

describe('Migration 265: workflow-run blocked retry persistence', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`
      CREATE TABLE space_workflow_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      INSERT INTO space_workflow_runs (id, status) VALUES ('run-1', 'blocked');
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('adds a nonnegative retry budget without changing existing runs', () => {
    runMigration265(db);
    runMigration265(db);

    const row = db
      .prepare(`SELECT id, status, blocked_retry_count FROM space_workflow_runs`)
      .get() as { id: string; status: string; blocked_retry_count: number };
    expect(row).toEqual({ id: 'run-1', status: 'blocked', blocked_retry_count: 0 });
    expect(() =>
      db.prepare(`UPDATE space_workflow_runs SET blocked_retry_count = -1 WHERE id = 'run-1'`).run()
    ).toThrow();
  });
});
