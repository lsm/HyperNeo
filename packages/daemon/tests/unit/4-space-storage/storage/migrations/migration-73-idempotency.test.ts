import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';

function tableSql(db: BunDatabase, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { sql: string } | undefined;
  return row?.sql ?? '';
}

describe('Migration 73 idempotency', () => {
  test('full migration rerun does not rebuild current space_tasks when foreign keys are enabled', () => {
    const db = new BunDatabase(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      runMigrations(db, () => {});

      db.prepare(
        `INSERT INTO spaces (id, slug, name, workspace_path, created_at, updated_at)
				 VALUES ('space-1', 'space-1', 'Space 1', '/tmp/space-1', 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO space_tasks
				 (id, space_id, task_number, title, status, priority, depends_on, created_at, updated_at)
				 VALUES ('task-approved', 'space-1', 1, 'Approved task', 'approved', 'normal', '[]', 1, 1)`
      ).run();

      expect(() => runMigrations(db, () => {})).not.toThrow();

      const task = db
        .prepare(`SELECT status FROM space_tasks WHERE id = 'task-approved'`)
        .get() as {
        status: string;
      };
      expect(task.status).toBe('approved');
      expect(tableSql(db, 'space_tasks')).toContain("'approved'");
    } finally {
      db.close();
    }
  });
});
