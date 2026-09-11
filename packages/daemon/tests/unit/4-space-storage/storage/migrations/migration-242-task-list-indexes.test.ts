import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../../src/storage/schema';
import { runMigration242 } from '../../../../../src/storage/schema/m242-task-list-indexes';

describe('core task list indexes', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
  });
  afterEach(() => db.close());

  test.each([false, true])('uses an ordered owner index with explicit status=%s', (filtered) => {
    for (const spaceId of [null, 'space']) {
      const owner = spaceId === null ? 'space_id IS NULL' : 'space_id = ?';
      const status = filtered ? 'status = ?' : "status != 'archived'";
      const values = [
        ...(spaceId === null ? [] : [spaceId]),
        ...(filtered ? ['open'] : []),
        100,
        'cursor',
        51,
      ];
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN SELECT * FROM space_tasks
        WHERE ${owner} AND ${status} AND (created_at, id) < (?, ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...values) as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail).join('\n');
      expect(details).toContain(
        filtered ? 'idx_space_tasks_owner_status_created' : 'idx_space_tasks_owner_created'
      );
      expect(details).toContain('created_at<?');
      expect(details).not.toContain('TEMP B-TREE');
    }
  });

  test('registration is marked and index creation is repeatable', () => {
    expect(
      db.prepare("SELECT key FROM migration_markers WHERE key = 'migration_242'").get()
    ).toEqual({ key: 'migration_242' });
    const before = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE name LIKE 'idx_space_tasks_owner_%' ORDER BY name"
      )
      .all();
    expect(before).toHaveLength(2);
    runMigration242(db);
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE name LIKE 'idx_space_tasks_owner_%' ORDER BY name"
        )
        .all()
    ).toEqual(before);
  });
});
