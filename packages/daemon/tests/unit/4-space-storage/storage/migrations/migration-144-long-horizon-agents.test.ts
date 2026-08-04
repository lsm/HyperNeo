import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import {
  coordinatorLongHorizonAgentId,
  coordinatorSessionId,
} from '../../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { runMigration144 } from '../../../../../src/storage/schema';

describe('Migration 144: long-horizon Space agents', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
			CREATE TABLE spaces (
				id TEXT PRIMARY KEY,
				slug TEXT NOT NULL,
				workspace_path TEXT NOT NULL,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE space_goals (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL
			);
			CREATE TABLE evolution_scopes (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL
			);
		`);
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space 1', 1, 1);
  });

  afterEach(() => {
    db.close();
  });

  test('creates long-horizon tables and backfills Coordinator rows', () => {
    runMigration144(db);

    const coordinator = db
      .prepare(
        `SELECT id, space_id, handle, display_name, template_key, status, session_id,
					instructions, autonomy_level, tool_permissions_json
				 FROM space_long_horizon_agents WHERE space_id = ?`
      )
      .get('space-1') as Record<string, unknown>;

    expect(coordinator).toEqual({
      id: coordinatorLongHorizonAgentId('space-1'),
      space_id: 'space-1',
      handle: 'coordinator',
      display_name: 'Coordinator',
      template_key: 'coordinator.default',
      status: 'active',
      session_id: coordinatorSessionId('space-1'),
      instructions: 'Coordinate goals, tasks, reminders, event subscriptions, and Space activity.',
      autonomy_level: null,
      tool_permissions_json: '{}',
    });
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('space_long_horizon_agent_reminders')
    ).toBeTruthy();
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('space_long_horizon_agent_event_subscriptions')
    ).toBeTruthy();
  });

  test('is idempotent and preserves existing Coordinator row', () => {
    runMigration144(db);
    db.prepare(`UPDATE space_long_horizon_agents SET instructions = ? WHERE id = ?`).run(
      'Custom Coordinator instructions.',
      coordinatorLongHorizonAgentId('space-1')
    );

    runMigration144(db);

    const rows = db
      .prepare(`SELECT instructions FROM space_long_horizon_agents WHERE space_id = ?`)
      .all('space-1') as Array<{ instructions: string }>;
    expect(rows).toEqual([{ instructions: 'Custom Coordinator instructions.' }]);
  });
});
