import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  runMigrations,
  createTables,
  runMigration48,
} from '../../../../../src/storage/schema/index.ts';

function indexExists(db: BunDatabase, indexName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!result;
}

describe('Migration 48: replace global short_id indexes with room-scoped composite indexes', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  test('drops old global idx_tasks_short_id and idx_goals_short_id indexes', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_short_id ON tasks(short_id) WHERE short_id IS NOT NULL`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_short_id ON goals(short_id) WHERE short_id IS NOT NULL`
    );

    expect(indexExists(db, 'idx_tasks_short_id')).toBe(true);
    expect(indexExists(db, 'idx_goals_short_id')).toBe(true);

    runMigration48(db);

    expect(indexExists(db, 'idx_tasks_short_id')).toBe(false);
    expect(indexExists(db, 'idx_goals_short_id')).toBe(false);
  });

  test('creates new room-scoped composite indexes after migration 48', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(indexExists(db, 'idx_tasks_room_short_id')).toBe(true);
    expect(indexExists(db, 'idx_goals_room_short_id')).toBe(true);
  });

  test('after migration 48, same short_id in different rooms is allowed for tasks', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES
				('room-1', 'Room 1', 1000, 1000),
				('room-2', 'Room 2', 1000, 1000)
		`);

    db.exec(`
			INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
			VALUES ('task-1', 'room-1', 'Task 1', '', 'pending', 'normal', 1000, 1000, 't-1')
		`);

    expect(() => {
      db.exec(`
				INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
				VALUES ('task-2', 'room-2', 'Task 2', '', 'pending', 'normal', 1001, 1001, 't-1')
			`);
    }).not.toThrow();
  });

  test('after migration 48, same short_id in different rooms is allowed for goals', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES
				('room-1', 'Room 1', 1000, 1000),
				('room-2', 'Room 2', 1000, 1000)
		`);

    db.exec(`
			INSERT INTO goals (id, room_id, title, description, status, created_at, updated_at, short_id)
			VALUES ('goal-1', 'room-1', 'Goal 1', '', 'active', 1000, 1000, 'g-1')
		`);

    expect(() => {
      db.exec(`
				INSERT INTO goals (id, room_id, title, description, status, created_at, updated_at, short_id)
				VALUES ('goal-2', 'room-2', 'Goal 2', '', 'active', 1001, 1001, 'g-1')
			`);
    }).not.toThrow();
  });

  test('after migration 48, duplicate short_id within the same room still throws for tasks', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(
      `INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Room 1', 1000, 1000)`
    );

    db.exec(`
			INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
			VALUES ('task-1', 'room-1', 'Task 1', '', 'pending', 'normal', 1000, 1000, 't-1')
		`);

    expect(() => {
      db.exec(`
				INSERT INTO tasks (id, room_id, title, description, status, priority, created_at, updated_at, short_id)
				VALUES ('task-2', 'room-1', 'Task 2', '', 'pending', 'normal', 1001, 1001, 't-1')
			`);
    }).toThrow();
  });

  test('after migration 48, duplicate short_id within the same room still throws for goals', () => {
    runMigrations(db, () => {});
    createTables(db);

    db.exec(
      `INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Room 1', 1000, 1000)`
    );

    db.exec(`
			INSERT INTO goals (id, room_id, title, description, status, created_at, updated_at, short_id)
			VALUES ('goal-1', 'room-1', 'Goal 1', '', 'active', 1000, 1000, 'g-1')
		`);

    expect(() => {
      db.exec(`
				INSERT INTO goals (id, room_id, title, description, status, created_at, updated_at, short_id)
				VALUES ('goal-2', 'room-1', 'Goal 2', '', 'active', 1001, 1001, 'g-1')
			`);
    }).toThrow();
  });

  test('migration 48 is idempotent — running it twice does not throw', () => {
    runMigrations(db, () => {});
    createTables(db);

    expect(() => runMigration48(db)).not.toThrow();
    expect(() => runMigration48(db)).not.toThrow();
  });
});
