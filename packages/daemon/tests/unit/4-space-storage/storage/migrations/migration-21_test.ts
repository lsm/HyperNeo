import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../../src/storage/schema/index.ts';

describe('Migration 21: submittedForReview backfill', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-21', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    const dbPath = join(testDir, 'test.db');
    db = new BunDatabase(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
			CREATE TABLE session_groups (
				id TEXT PRIMARY KEY,
				group_type TEXT NOT NULL DEFAULT 'task',
				ref_id TEXT NOT NULL,
				state TEXT NOT NULL DEFAULT 'awaiting_worker'
					CHECK(state IN ('awaiting_worker', 'awaiting_leader', 'awaiting_human', 'completed', 'failed')),
				version INTEGER NOT NULL DEFAULT 0,
				metadata TEXT NOT NULL DEFAULT '{}',
				created_at INTEGER NOT NULL,
				completed_at INTEGER
			)
		`);
  });

  test('backfills active awaiting_human groups', () => {
    db.exec(`
			INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at, completed_at)
			VALUES
				('g-awaiting', 'task', 't-1', 'awaiting_human', 0, '{}', 1, NULL),
				('g-other', 'task', 't-2', 'awaiting_worker', 0, '{}', 1, NULL),
				('g-completed', 'task', 't-3', 'awaiting_human', 0, '{}', 1, 2)
		`);

    runMigrations(db, () => {});

    const awaiting = db
      .prepare(`SELECT metadata FROM session_groups WHERE id = 'g-awaiting'`)
      .get() as { metadata: string };
    const other = db.prepare(`SELECT metadata FROM session_groups WHERE id = 'g-other'`).get() as {
      metadata: string;
    };
    const completed = db
      .prepare(`SELECT metadata FROM session_groups WHERE id = 'g-completed'`)
      .get() as { metadata: string };

    expect((JSON.parse(awaiting.metadata) as Record<string, unknown>).submittedForReview).toBe(
      true
    );
    expect(
      (JSON.parse(other.metadata) as Record<string, unknown>).submittedForReview
    ).toBeUndefined();
    expect(
      (JSON.parse(completed.metadata) as Record<string, unknown>).submittedForReview
    ).toBeUndefined();
  });

  test('handles malformed metadata rows', () => {
    db.exec(`
			INSERT INTO session_groups (id, group_type, ref_id, state, version, metadata, created_at, completed_at)
			VALUES ('g-bad', 'task', 't-1', 'awaiting_human', 0, '{bad-json}', 1, NULL)
		`);

    runMigrations(db, () => {});

    const row = db.prepare(`SELECT metadata FROM session_groups WHERE id = 'g-bad'`).get() as {
      metadata: string;
    };
    expect((JSON.parse(row.metadata) as Record<string, unknown>).submittedForReview).toBe(true);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore errors
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });
});
