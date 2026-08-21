import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

describe('Migration 24: rename failed → needs_attention', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-24', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				background_context TEXT,
				instructions TEXT,
				allowed_paths TEXT DEFAULT '[]',
				default_path TEXT,
				default_model TEXT,
				allowed_models TEXT DEFAULT '[]',
				session_ids TEXT DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
				config TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);

    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at)
			VALUES ('room-1', 'Test Room', ${Date.now()}, ${Date.now()})
		`);

    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'failed', 'cancelled')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				task_type TEXT DEFAULT 'coding' CHECK(task_type IN ('planning', 'coding', 'research', 'design', 'goal_review')),
				assigned_agent TEXT DEFAULT 'coder',
				created_by_task_id TEXT,
				archived_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			)
		`);
    db.exec(`PRAGMA foreign_keys = ON`);
  });

  test('converts existing failed tasks to needs_attention', () => {
    const now = Date.now();
    db.exec(`PRAGMA ignore_check_constraints = 1`);
    db.exec(`
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES
				('t-failed', 'room-1', 'Failed Task', 'desc', 'failed', ${now}),
				('t-pending', 'room-1', 'Pending Task', 'desc', 'pending', ${now}),
				('t-completed', 'room-1', 'Completed Task', 'desc', 'completed', ${now}),
				('t-cancelled', 'room-1', 'Cancelled Task', 'desc', 'cancelled', ${now})
		`);
    db.exec(`PRAGMA ignore_check_constraints = 0`);

    runMigrations(db, () => {});

    const failedTask = db.prepare(`SELECT status FROM tasks WHERE id = 't-failed'`).get() as {
      status: string;
    };
    const pendingTask = db.prepare(`SELECT status FROM tasks WHERE id = 't-pending'`).get() as {
      status: string;
    };
    const completedTask = db.prepare(`SELECT status FROM tasks WHERE id = 't-completed'`).get() as {
      status: string;
    };
    const cancelledTask = db.prepare(`SELECT status FROM tasks WHERE id = 't-cancelled'`).get() as {
      status: string;
    };

    expect(failedTask.status).toBe('needs_attention');
    expect(pendingTask.status).toBe('pending');
    expect(completedTask.status).toBe('completed');
    expect(cancelledTask.status).toBe('cancelled');
  }, 15000);

  test('updated constraint accepts needs_attention but rejects failed', () => {
    runMigrations(db, () => {});

    const now = Date.now();

    expect(() => {
      db.exec(`
				INSERT INTO tasks (id, room_id, title, description, status, created_at)
				VALUES ('t-ok', 'room-1', 'Task', 'desc', 'needs_attention', ${now})
			`);
    }).not.toThrow();

    expect(() => {
      db.exec(`
				INSERT INTO tasks (id, room_id, title, description, status, created_at)
				VALUES ('t-bad', 'room-1', 'Task', 'desc', 'failed', ${now})
			`);
    }).toThrow();
  });

  test('is idempotent when run on already-migrated database', () => {
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });
});
