import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  runMigrations,
  createTables,
  runMigration47,
  runMigration48,
} from '../../../../../src/storage/schema/index.ts';

function columnExists(db: BunDatabase, table: string, column: string): boolean {
  const result = db
    .prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column);
  return !!result;
}

function tableExists(db: BunDatabase, tableName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(tableName);
  return !!result;
}

function indexExists(db: BunDatabase, indexName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!result;
}

describe('Migration 47: add short_id columns and short_id_counters table', () => {
  let testDir: string;
  let db: BunDatabase;

  const HOOK_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-47', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  }, HOOK_TIMEOUT_MS);

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }, HOOK_TIMEOUT_MS);

  test('fresh DB has short_id_counters table with correct schema', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(tableExists(db, 'short_id_counters')).toBe(true);
    expect(columnExists(db, 'short_id_counters', 'entity_type')).toBe(true);
    expect(columnExists(db, 'short_id_counters', 'scope_id')).toBe(true);
    expect(columnExists(db, 'short_id_counters', 'counter')).toBe(true);
  });

  test('existing DB without short_id gets columns added by migration', () => {
    db.exec(`
			CREATE TABLE rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    db.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				priority TEXT NOT NULL DEFAULT 'normal',
				created_at INTEGER NOT NULL,
				updated_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);
    db.exec(`
			CREATE TABLE goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'active',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);

    db.exec(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('r1', 'Room', 1, 1)`);
    db.exec(
      `INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at) VALUES ('t1', 'r1', 'Task', '', 'pending', 'normal', 1, 1)`
    );
    db.exec(
      `INSERT INTO goals (id, room_id, title, description, status, created_at, updated_at) VALUES ('g1', 'r1', 'Goal', '', 'active', 1, 1)`
    );

    expect(columnExists(db, 'tasks', 'short_id')).toBe(false);
    expect(columnExists(db, 'goals', 'short_id')).toBe(false);

    runMigration47(db);

    expect(columnExists(db, 'tasks', 'short_id')).toBe(true);
    expect(columnExists(db, 'goals', 'short_id')).toBe(true);

    expect(indexExists(db, 'idx_tasks_room_short_id')).toBe(true);
    expect(indexExists(db, 'idx_goals_room_short_id')).toBe(true);

    expect(tableExists(db, 'short_id_counters')).toBe(true);

    const task = db.prepare(`SELECT title, short_id FROM tasks WHERE id='t1'`).get() as {
      title: string;
      short_id: string | null;
    };
    expect(task.title).toBe('Task');
    expect(task.short_id).toBeNull();

    const goal = db.prepare(`SELECT title, short_id FROM goals WHERE id='g1'`).get() as {
      title: string;
      short_id: string | null;
    };
    expect(goal.title).toBe('Goal');
    expect(goal.short_id).toBeNull();
  });

  test('short_id_counters table enforces composite PRIMARY KEY', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(
      `INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-1', 1)`
    );

    expect(() => {
      db.exec(
        `INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-1', 2)`
      );
    }).toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('task', 'room-2', 1)`
      );
    }).not.toThrow();

    expect(() => {
      db.exec(
        `INSERT INTO short_id_counters (entity_type, scope_id, counter) VALUES ('goal', 'room-1', 1)`
      );
    }).not.toThrow();
  });

  test('migration is idempotent — running runMigrations twice does not throw', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(() => {
      runMigrations(db, () => {});
    }).not.toThrow();
  });
});
