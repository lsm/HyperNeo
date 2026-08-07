/**
 * Migration 42 Tests
 *
 * Tests for Migration 42: Clean up stale/zombie session groups and add partial
 * unique index on session_groups(ref_id) WHERE completed_at IS NULL.
 *
 * Covers:
 * - Fresh DB: unique index exists after full migration chain
 * - Fresh DB: duplicate active groups are rejected by the unique constraint
 * - Existing DB with zombie groups (active groups for terminal tasks): zombies are completed
 * - Existing DB with duplicate active groups: older duplicates are completed, newest kept
 * - Idempotency: running migration twice does not error
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations, createTables } from '../../../../../src/storage/schema/index.ts';

function indexExists(db: BunDatabase, indexName: string): boolean {
  const result = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
    .get(indexName);
  return !!result;
}

describe('Migration 42: Zombie group cleanup + partial unique index', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-42', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Fresh DB — full schema + migration chain
  // -------------------------------------------------------------------------

  test('fresh DB: idx_session_groups_active_ref unique index exists', () => {
    createTables(db);
    runMigrations(db, () => {});
    expect(indexExists(db, 'idx_session_groups_active_ref')).toBe(true);
  });

  test('fresh DB: unique constraint prevents two active groups for same task', () => {
    createTables(db);
    runMigrations(db, () => {});

    const now = Date.now();
    // Insert first active group
    db.prepare(
      `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('group-a', 'task', 'task-x', 0, '{}', ?)`
    ).run(now);

    // Second insert for same ref_id with completed_at IS NULL should fail
    expect(() => {
      db.prepare(
        `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('group-b', 'task', 'task-x', 0, '{}', ?)`
      ).run(now + 1);
    }).toThrow();
  });

  test('fresh DB: completed groups do not violate the unique constraint', () => {
    createTables(db);
    runMigrations(db, () => {});

    const now = Date.now();
    // Insert a completed group
    db.prepare(
      `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at, completed_at)
			 VALUES ('group-a', 'task', 'task-x', 0, '{}', ?, ?)`
    ).run(now - 1000, now - 500);

    // A new active group for the same ref_id is allowed (completed_at IS NULL)
    expect(() => {
      db.prepare(
        `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('group-b', 'task', 'task-x', 0, '{}', ?)`
      ).run(now);
    }).not.toThrow();
  });

  test('fresh DB: non-task group types with same ref_id are not blocked by the constraint', () => {
    createTables(db);
    runMigrations(db, () => {});

    const now = Date.now();
    // Insert an active task group
    db.prepare(
      `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			 VALUES ('task-grp', 'task', 'shared-ref', 0, '{}', ?)`
    ).run(now);

    // A different group type with the same ref_id should NOT be blocked
    expect(() => {
      db.prepare(
        `INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
				 VALUES ('other-grp', 'planning', 'shared-ref', 0, '{}', ?)`
      ).run(now + 1);
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Existing DB with zombie groups (active groups for terminal tasks)
  // -------------------------------------------------------------------------

  test('existing DB: zombie groups for terminal tasks are completed by migration', () => {
    // Build a pre-migration DB state with stale groups.
    // The tasks status CHECK must include 'review' (and not 'escalated') to prevent
    // migration 16 from attempting to recreate the table with missing columns.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL REFERENCES rooms(id),
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
		`);

    const now = Date.now();
    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now});
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES ('task-done', 'room-1', 'Done Task', 'desc', 'completed', ${now});
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES ('task-active', 'room-1', 'Active Task', 'desc', 'in_progress', ${now});

			-- Zombie: active group for a completed task
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('zombie-grp', 'task', 'task-done', 0, '{}', ${now - 1000});

			-- Legitimate: active group for an in-progress task
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('legit-grp', 'task', 'task-active', 0, '{}', ${now});
		`);

    // Run migrations (which includes migration 42)
    runMigrations(db, () => {});

    // Zombie should be completed
    const zombie = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'zombie-grp'`)
      .get() as { completed_at: number | null };
    expect(zombie.completed_at).not.toBeNull();

    // Legitimate group should still be active
    const legit = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'legit-grp'`)
      .get() as { completed_at: number | null };
    expect(legit.completed_at).toBeNull();
  });

  test('existing DB: zombie groups for needs_attention tasks are completed by migration', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL REFERENCES rooms(id),
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
		`);

    const now = Date.now();
    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now});
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES ('task-failed', 'room-1', 'Failed Task', 'desc', 'needs_attention', ${now});

			-- Zombie: active group for a needs_attention task (crash after failTask ran)
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('zombie-failed', 'task', 'task-failed', 0, '{}', ${now - 1000});
		`);

    runMigrations(db, () => {});

    const zombie = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'zombie-failed'`)
      .get() as { completed_at: number | null };
    expect(zombie.completed_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Existing DB with duplicate active groups
  // -------------------------------------------------------------------------

  test('existing DB: oldest duplicates are completed, newest kept active', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL REFERENCES rooms(id),
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
		`);

    const now = Date.now();
    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now});
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES ('task-1', 'room-1', 'Task 1', 'desc', 'in_progress', ${now});

			-- Three active groups for same task (duplicate problem)
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('old-grp', 'task', 'task-1', 0, '{}', ${now - 2000});
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('mid-grp', 'task', 'task-1', 0, '{}', ${now - 1000});
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('new-grp', 'task', 'task-1', 0, '{}', ${now});
		`);

    runMigrations(db, () => {});

    // Newest group should remain active
    const newGrp = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'new-grp'`)
      .get() as { completed_at: number | null };
    expect(newGrp.completed_at).toBeNull();

    // Older groups should be completed
    const oldGrp = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'old-grp'`)
      .get() as { completed_at: number | null };
    expect(oldGrp.completed_at).not.toBeNull();

    const midGrp = db
      .prepare(`SELECT completed_at FROM session_groups WHERE id = 'mid-grp'`)
      .get() as { completed_at: number | null };
    expect(midGrp.completed_at).not.toBeNull();
  });

  test('existing DB: duplicate groups with identical created_at are deduped via rowid', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
			CREATE TABLE IF NOT EXISTS rooms (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL REFERENCES rooms(id),
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('draft', 'pending', 'in_progress', 'review', 'completed', 'needs_attention', 'cancelled', 'archived')),
				priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				depends_on TEXT DEFAULT '[]',
				task_type TEXT DEFAULT 'coding',
				assigned_agent TEXT DEFAULT 'coder',
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS session_group_members (
				group_id TEXT NOT NULL REFERENCES session_groups(id) ON DELETE CASCADE,
				session_id TEXT NOT NULL,
				role TEXT NOT NULL,
				joined_at INTEGER NOT NULL,
				PRIMARY KEY (group_id, session_id)
			);
		`);

    const now = Date.now();
    db.exec(`
			INSERT INTO rooms (id, name, created_at, updated_at) VALUES ('room-1', 'Test', ${now}, ${now});
			INSERT INTO tasks (id, room_id, title, description, status, created_at)
			VALUES ('task-1', 'room-1', 'Task 1', 'desc', 'in_progress', ${now});

			-- Two groups with IDENTICAL created_at (timestamp collision under load)
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('grp-a', 'task', 'task-1', 0, '{}', ${now});
			INSERT INTO session_groups (id, group_type, ref_id, version, metadata, created_at)
			VALUES ('grp-b', 'task', 'task-1', 0, '{}', ${now});
		`);

    // Should not throw even with identical created_at (rowid tiebreaker handles it)
    expect(() => runMigrations(db, () => {})).not.toThrow();

    // One group should remain active, one should be completed
    const grpA = db.prepare(`SELECT completed_at FROM session_groups WHERE id = 'grp-a'`).get() as {
      completed_at: number | null;
    };
    const grpB = db.prepare(`SELECT completed_at FROM session_groups WHERE id = 'grp-b'`).get() as {
      completed_at: number | null;
    };

    // Exactly one should be active (completed_at IS NULL), one should be completed
    const activeCount = [grpA, grpB].filter((g) => g.completed_at === null).length;
    expect(activeCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  test('idempotency: running migrations twice does not error', () => {
    createTables(db);
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });
});
