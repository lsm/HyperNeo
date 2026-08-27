import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration219 } from '../../../../../src/storage/schema/m219-space-tasks-workspace-path';
import { runMigrations } from '../../../../../src/storage/schema';

function createPreMigrationDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE space_tasks (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

function insertPreMigrationTask(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO space_tasks (id, space_id, title, status, created_at, updated_at)
     VALUES (?, 'space-1', ?, 'open', 1, 1)`
  ).run(id, `Task ${id}`);
}

describe('migration 219 — space_tasks.workspace_path', () => {
  test('adds nullable workspace_path and leaves existing rows NULL', () => {
    const db = createPreMigrationDb();
    insertPreMigrationTask(db, 't-1');
    insertPreMigrationTask(db, 't-2');

    runMigration219(db);

    const column = db
      .prepare(`SELECT name FROM pragma_table_info('space_tasks') WHERE name = 'workspace_path'`)
      .get();
    expect(column).toBeDefined();

    const rows = db
      .prepare(`SELECT id, workspace_path FROM space_tasks ORDER BY id`)
      .all() as Array<{ id: string; workspace_path: string | null }>;
    expect(rows).toEqual([
      { id: 't-1', workspace_path: null },
      { id: 't-2', workspace_path: null },
    ]);
    db.close();
  });

  test('is a no-op when the column already exists', () => {
    const db = createPreMigrationDb();
    insertPreMigrationTask(db, 't-1');

    runMigration219(db);
    db.prepare(`UPDATE space_tasks SET workspace_path = '/ws/custom' WHERE id = 't-1'`).run();
    runMigration219(db);

    const row = db.prepare(`SELECT workspace_path FROM space_tasks WHERE id = 't-1'`).get() as {
      workspace_path: string | null;
    };
    expect(row.workspace_path).toBe('/ws/custom');
    db.close();
  });

  test('fresh databases get the column through the full migration chain', () => {
    const db = new BunDatabase(':memory:');
    runMigrations(db, () => {});

    const hasColumn = db
      .prepare(`SELECT 1 FROM pragma_table_info('space_tasks') WHERE name = 'workspace_path'`)
      .get();
    expect(hasColumn).toBeDefined();

    const marker = db
      .prepare(`SELECT applied_at FROM migration_markers WHERE key = 'migration_219'`)
      .get();
    expect(marker).toBeDefined();
    db.close();
  });
});
