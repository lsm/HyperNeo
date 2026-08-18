import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration71 } from '../../../../../src/storage/schema/migrations';

function createGoalsTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active',
			priority TEXT NOT NULL DEFAULT 'normal',
			progress INTEGER NOT NULL DEFAULT 0,
			linked_task_ids TEXT NOT NULL DEFAULT '[]',
			metrics TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			schedule TEXT,
			schedule_paused INTEGER NOT NULL DEFAULT 0,
			next_run_at INTEGER
		)
	`);
}

function insertGoal(db: BunDatabase, id: string, schedule: string | null): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO goals (id, room_id, title, description, status, priority, progress, linked_task_ids, metrics, created_at, updated_at, schedule)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'room-1', 'Test Goal', 'Desc', 'active', 'normal', 0, '[]', '{}', now, now, schedule);
}

describe('Migration 71: Fix corrupted schedule values in goals table', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
  });

  afterEach(() => {
    db.close();
  });

  test('wraps a bare cron string like @daily into proper JSON', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-1', '@daily');

    runMigration71(db);

    const row = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-1'`).get() as {
      schedule: string;
    };
    const parsed = JSON.parse(row.schedule) as { expression: string; timezone: string };
    expect(parsed.expression).toBe('@daily');
    expect(parsed.timezone).toBe('UTC');
  });

  test('wraps a 5-field cron string into proper JSON', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-2', '0 9 * * 1');

    runMigration71(db);

    const row = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-2'`).get() as {
      schedule: string;
    };
    const parsed = JSON.parse(row.schedule) as { expression: string; timezone: string };
    expect(parsed.expression).toBe('0 9 * * 1');
    expect(parsed.timezone).toBe('UTC');
  });

  test('leaves already-valid JSON schedule unchanged', () => {
    createGoalsTable(db);
    const validSchedule = JSON.stringify({ expression: '0 9 * * *', timezone: 'UTC' });
    insertGoal(db, 'goal-3', validSchedule);

    runMigration71(db);

    const row = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-3'`).get() as {
      schedule: string;
    };
    expect(row.schedule).toBe(validSchedule);
  });

  test('handles null schedule correctly (no-op)', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-4', null);

    runMigration71(db);

    const row = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-4'`).get() as {
      schedule: string | null;
    };
    expect(row.schedule).toBeNull();
  });

  test('is idempotent — running twice does not change anything', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-5', '@weekly');

    runMigration71(db);
    const afterFirst = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-5'`).get() as {
      schedule: string;
    };

    runMigration71(db);
    const afterSecond = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-5'`).get() as {
      schedule: string;
    };

    expect(afterSecond.schedule).toBe(afterFirst.schedule);
  });

  test('handles a JSON-quoted string like "@daily" by wrapping it', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-6', '"@daily"');

    runMigration71(db);

    const row = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-6'`).get() as {
      schedule: string;
    };
    const parsed = JSON.parse(row.schedule) as { expression: string; timezone: string };
    expect(parsed.expression).toBe('@daily');
    expect(parsed.timezone).toBe('UTC');
  });

  test('is no-op when goals table does not exist', () => {
    expect(() => runMigration71(db)).not.toThrow();
  });

  test('is no-op when goals table has no schedule column', () => {
    db.exec(`
			CREATE TABLE IF NOT EXISTS goals (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL
			)
		`);
    expect(() => runMigration71(db)).not.toThrow();
  });

  test('handles multiple goals with mixed schedule states', () => {
    createGoalsTable(db);
    insertGoal(db, 'goal-a', '@daily');
    insertGoal(db, 'goal-b', JSON.stringify({ expression: '0 9 * * *', timezone: 'UTC' }));
    insertGoal(db, 'goal-c', null);
    insertGoal(db, 'goal-d', 'not-valid-cron');

    runMigration71(db);

    const a = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-a'`).get() as {
      schedule: string;
    };
    const b = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-b'`).get() as {
      schedule: string;
    };
    const c = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-c'`).get() as {
      schedule: string | null;
    };
    const d = db.prepare(`SELECT schedule FROM goals WHERE id = 'goal-d'`).get() as {
      schedule: string;
    };

    expect(JSON.parse(a.schedule)).toEqual({ expression: '@daily', timezone: 'UTC' });
    expect(JSON.parse(b.schedule)).toEqual({ expression: '0 9 * * *', timezone: 'UTC' });
    expect(c.schedule).toBeNull();
    expect(JSON.parse(d.schedule)).toEqual({ expression: 'not-valid-cron', timezone: 'UTC' });
  });
});
