import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration142, runMigration143 } from '../../../../../src/storage/schema/index.ts';

const SCOPE_ID = 'b2ff245a-98ef-4429-954a-3e7b96366cfa';
const GOAL_ID = '10612c8d-e412-4169-8429-b48fa4d3e234';

function createMigration142Tables(db: BunDatabase): void {
  db.exec(`
		CREATE TABLE evolution_scopes (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			space_goal_id TEXT,
			kind TEXT NOT NULL,
			name TEXT NOT NULL,
			objective TEXT NOT NULL,
			parent_scope_id TEXT,
			metric_definitions_json TEXT NOT NULL DEFAULT '[]',
			policy_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE evolution_evidence (
			id TEXT PRIMARY KEY,
			scope_id TEXT NOT NULL,
			kind TEXT NOT NULL
				CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot')),
			summary TEXT NOT NULL,
			source_id TEXT,
			metadata_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			task_number INTEGER NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL,
			priority TEXT NOT NULL,
			workflow_run_id TEXT,
			reported_status TEXT,
			reported_summary TEXT,
			result TEXT,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE space_workflow_runs (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			failure_reason TEXT,
			completed_at INTEGER,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE workflow_run_artifacts (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			node_id TEXT NOT NULL,
			artifact_type TEXT NOT NULL,
			artifact_key TEXT NOT NULL DEFAULT '',
			data TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
}

function seedForgeMvpTask(db: BunDatabase): void {
  db.prepare(
    `INSERT INTO evolution_scopes (
			id, space_id, space_goal_id, kind, name, objective, parent_scope_id,
			metric_definitions_json, policy_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    SCOPE_ID,
    'space-1',
    GOAL_ID,
    'mission',
    'Build and harden NeoKai Forge',
    'Improve Forge',
    null,
    '[]',
    '{}',
    1,
    1
  );
  db.prepare(
    `INSERT INTO space_tasks (
			id, task_number, title, description, status, priority, workflow_run_id,
			reported_status, reported_summary, result, completed_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'task-425',
    425,
    'Forge MVP 1: storage and shared contracts',
    'Add storage',
    'done',
    'high',
    'run-425',
    null,
    null,
    null,
    100,
    100
  );
  db.prepare(
    `INSERT INTO space_workflow_runs (
			id, title, status, failure_reason, completed_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)`
  ).run('run-425', 'Forge MVP 1', 'done', null, 101, 101);
  db.prepare(
    `INSERT INTO workflow_run_artifacts (
			id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'artifact-425-review',
    'run-425',
    'review',
    'result',
    'review-round-1',
    JSON.stringify({
      summary: 'Requested changes: duplicate helper table.',
      verdict: 'REQUEST_CHANGES',
      pr_url: 'https://github.com/lsm/neokai/pull/1963',
    }),
    50,
    50
  );
  db.prepare(
    `INSERT INTO workflow_run_artifacts (
			id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'artifact-425-merge',
    'run-425',
    'review',
    'result',
    'merged',
    JSON.stringify({
      summary: 'PR #1963 merged (squash) to dev.',
      merged_pr_url: 'https://github.com/lsm/neokai/pull/1963',
    }),
    75,
    75
  );
}

describe('Migration 142: Forge MVP evidence backfill', () => {
  let testDir: string;
  let db: BunDatabase;

  beforeEach(() => {
    testDir = join(process.cwd(), 'tmp', 'test-migration-142', `test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = new BunDatabase(join(testDir, 'test.db'));
    createMigration142Tables(db);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('widens evidence kinds and backfills task result, artifact, and error records', () => {
    seedForgeMvpTask(db);

    runMigration142(db);

    const rows = db
      .prepare(
        `SELECT id, kind, source_id, summary, metadata_json
				 FROM evolution_evidence
				 WHERE id LIKE 'forge-mvp-425-%'
				 ORDER BY id`
      )
      .all() as Array<{
      id: string;
      kind: string;
      source_id: string;
      summary: string;
      metadata_json: string;
    }>;

    expect(rows.map((row) => `${row.id}:${row.kind}`)).toEqual([
      'forge-mvp-425-artifact:artifact',
      'forge-mvp-425-error:error',
      'forge-mvp-425-task-result:task_result',
    ]);
    expect(rows[0].source_id).toBe('run-425');
    expect(rows[1].summary).toContain('Requested changes');
    expect(rows[2].source_id).toBe('task-425');
    expect(JSON.parse(rows[0].metadata_json).artifacts).toHaveLength(2);

    expect(() =>
      db
        .prepare(
          `INSERT INTO evolution_evidence (
						id, scope_id, kind, summary, source_id, metadata_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('manual-artifact', SCOPE_ID, 'artifact', 'Manual artifact', 'run-425', '{}', 200)
    ).not.toThrow();
  });

  test('is idempotent', () => {
    seedForgeMvpTask(db);

    runMigration142(db);
    runMigration142(db);

    const rows = db
      .prepare(`SELECT COUNT(*) count FROM evolution_evidence WHERE id LIKE 'forge-mvp-425-%'`)
      .get() as { count: number };
    expect(rows.count).toBe(3);
  });

  test('runs on legacy space_tasks schemas without space_id and widens trace evidence kinds', () => {
    seedForgeMvpTask(db);

    runMigration142(db);
    runMigration143(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO evolution_evidence (
						id, scope_id, kind, summary, source_id, metadata_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('manual-retry-loop', SCOPE_ID, 'retry_loop', 'Retry loop', 'task-425', '{}', 200)
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO evolution_evidence (
						id, scope_id, kind, summary, source_id, metadata_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('manual-slow-tool', SCOPE_ID, 'slow_tool_call', 'Slow tool', 'task-425', '{}', 201)
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO evolution_evidence (
						id, scope_id, kind, summary, source_id, metadata_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'manual-conversation-friction',
          SCOPE_ID,
          'conversation_friction',
          'Conversation friction',
          'task-425',
          '{}',
          202
        )
    ).not.toThrow();
  });
});
