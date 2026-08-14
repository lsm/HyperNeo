/**
 * Migration 194 Tests — widen space_goal_events.event_type CHECK to include
 * 'automation_noop'.
 *
 * The self_nag goal-automation retrospective (#919) records a lightweight no-op
 * note on the goal when the evidence-quality preflight flags thin, process-level
 * evidence. That note uses a dedicated 'automation_noop' event type. SQLite
 * cannot ALTER a CHECK constraint, so M194 rebuilds the table (same pattern as
 * M183). These tests cover the widen, data/index preservation, idempotency, and
 * a safe no-op when the table is absent.
 */

import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration194 } from '../../../../../src/storage/schema/index.ts';

function createOldGoalEventsTables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE spaces (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
		CREATE TABLE space_goals (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, created_at INTEGER NOT NULL);
		CREATE TABLE space_goal_events (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			event_type TEXT NOT NULL
				CHECK(event_type IN ('created', 'updated', 'status_changed', 'task_triggered', 'task_queued', 'task_terminal', 'schedule_updated')),
			source TEXT NOT NULL,
			source_task_id TEXT,
			source_session_id TEXT,
			previous_state TEXT,
			new_state TEXT,
			diff TEXT,
			note TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC);
	`);
}

function insertEvent(
  db: BunDatabase,
  id: string,
  eventType: string,
  note: string | null,
  createdAt: number
): void {
  db.prepare(
    `INSERT INTO space_goal_events (id, space_id, goal_id, event_type, source, note, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, 'space-1', 'goal-1', eventType, 'system', note, createdAt);
}

describe('runMigration194', () => {
  test('widens event_type CHECK to allow automation_noop and preserves data + indexes', () => {
    const db = new BunDatabase(':memory:');
    createOldGoalEventsTables(db);
    insertEvent(db, 'event-1', 'updated', 'pre-existing note', 100);

    // Before migration: automation_noop is rejected by the CHECK.
    expect(() => insertEvent(db, 'event-bad', 'automation_noop', null, 101)).toThrow();

    runMigration194(db);

    // After migration: automation_noop is accepted.
    insertEvent(db, 'event-2', 'automation_noop', 'no-op note', 102);

    const rows = db
      .prepare(`SELECT id, event_type, note FROM space_goal_events ORDER BY created_at ASC`)
      .all() as Array<{ id: string; event_type: string; note: string | null }>;
    expect(rows).toEqual([
      { id: 'event-1', event_type: 'updated', note: 'pre-existing note' },
      { id: 'event-2', event_type: 'automation_noop', note: 'no-op note' },
    ]);

    // Index preserved across the table rebuild.
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'space_goal_events' AND sql IS NOT NULL`
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain('idx_space_goal_events_goal_created');

    db.close();
  });

  test('is idempotent when the CHECK already permits automation_noop', () => {
    const db = new BunDatabase(':memory:');
    createOldGoalEventsTables(db);
    runMigration194(db);
    // Running again must not throw or drop data.
    runMigration194(db);
    insertEvent(db, 'event-1', 'automation_noop', 'note', 100);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM space_goal_events`).get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  test('is a safe no-op when space_goal_events does not exist', () => {
    const db = new BunDatabase(':memory:');
    expect(() => runMigration194(db)).not.toThrow();
    db.close();
  });
});
