import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';
import { createTables } from '../../../../../src/storage/schema/index.ts';

function createLegacyGoalsTable(db: BunDatabase): void {
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal'
				CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			progress INTEGER DEFAULT 0,
			linked_task_ids TEXT DEFAULT '[]',
			metrics TEXT DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			planning_attempts INTEGER DEFAULT 0,
			goal_review_attempts INTEGER DEFAULT 0,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);
  db.exec(`PRAGMA foreign_keys = ON`);
}

function insertRoom(db: BunDatabase, id = 'room-1'): void {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at)
		 VALUES ('${id}', 'Test Room', ${now}, ${now})`
  );
}

describe('Migration 28: mission metadata schema additions', () => {
  let testDir: string;
  let db: BunDatabase;

  const HOOK_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-28', `test-${Date.now()}`);
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
    insertRoom(db);
  }, HOOK_TIMEOUT_MS);

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }, HOOK_TIMEOUT_MS);

  test('migration adds new columns to existing goals table and backfills defaults', () => {
    createLegacyGoalsTable(db);

    const now = Date.now();
    db.exec(
      `INSERT INTO goals (id, room_id, title, description, status, priority, created_at, updated_at)
			 VALUES ('goal-1', 'room-1', 'Old Goal', '', 'active', 'normal', ${now}, ${now})`
    );

    runMigrations(db, () => {});

    const row = db.prepare(`SELECT * FROM goals WHERE id = 'goal-1'`).get() as Record<
      string,
      unknown
    >;
    expect(row.mission_type).toBe('one_shot');
    expect(row.autonomy_level).toBe('supervised');
    expect(row.schedule_paused).toBe(0);
    expect(row.max_consecutive_failures).toBe(3);
    expect(row.max_planning_attempts).toBe(0);
    expect(row.consecutive_failures).toBe(0);
    expect(row.schedule).toBeNull();
    expect(row.next_run_at).toBeNull();
    expect(row.structured_metrics).toBeNull();
  });

  test('migration is idempotent — running twice does not throw', () => {
    createLegacyGoalsTable(db);
    runMigrations(db, () => {});
    expect(() => runMigrations(db, () => {})).not.toThrow();
  });
});
