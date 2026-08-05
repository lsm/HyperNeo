import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration139 } from '../../../../../src/storage/schema/index.ts';

function createLegacyCursorTable(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE goal_automation_cursors (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			trigger_kind TEXT NOT NULL
				CHECK(trigger_kind IN ('completed_task_threshold', 'self_nag', 'external_event')),
			trigger_key TEXT NOT NULL,
			last_evidence_created_at INTEGER,
			last_task_completed_at INTEGER,
			last_external_event_id TEXT,
			last_episode_id TEXT,
			last_fired_at INTEGER,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE(goal_id, trigger_kind, trigger_key)
		);
		CREATE INDEX idx_goal_automation_cursors_scope
		ON goal_automation_cursors(scope_id, updated_at DESC);
		CREATE INDEX idx_goal_automation_cursors_external_event
		ON goal_automation_cursors(last_external_event_id);
	`);
}

describe('Migration 139: Goal automation cursors', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-139', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('recreates cursor indexes after rebuilding the legacy unique constraint', () => {
    createLegacyCursorTable(db);

    runMigration139(db);

    const tableSql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'goal_automation_cursors'`
      )
      .get() as { sql: string };
    expect(tableSql.sql).toContain('last_evidence_id TEXT');
    expect(tableSql.sql).toContain('UNIQUE(goal_id, scope_id, trigger_kind, trigger_key)');

    const indexes = db
      .prepare(
        `SELECT name, tbl_name FROM sqlite_master
				 WHERE type = 'index' AND name IN (
					'idx_goal_automation_cursors_scope',
					'idx_goal_automation_cursors_external_event'
				 )
				 ORDER BY name`
      )
      .all() as Array<{ name: string; tbl_name: string }>;
    expect(indexes).toEqual([
      {
        name: 'idx_goal_automation_cursors_external_event',
        tbl_name: 'goal_automation_cursors',
      },
      { name: 'idx_goal_automation_cursors_scope', tbl_name: 'goal_automation_cursors' },
    ]);
  });
});
