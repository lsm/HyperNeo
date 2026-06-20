import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration160 } from '../../../../../src/storage/schema/migrations';

describe('Migration 160: backfill friction_digest evidence kind', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
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
      )
    `);
    db.prepare(
      `INSERT INTO evolution_scopes (id, space_id, kind, name, objective, created_at, updated_at) VALUES (?, ?, 'custom', 'scope', 'scope', 1, 1)`
    ).run('scope-1', 'space-1');
    db.exec(`
      CREATE TABLE evolution_evidence (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error', 'daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception', 'error_cluster', 'retry_loop', 'tool_failure', 'test_failure', 'permission_block', 'slow_tool_call', 'conversation_friction', 'verification_triage')),
        summary TEXT NOT NULL,
        source_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  test('widens databases that already have verification_triage but not friction_digest', () => {
    db.prepare(
      `INSERT INTO evolution_evidence (id, scope_id, kind, summary, metadata_json, created_at)
       VALUES (?, ?, 'verification_triage', 'existing triage', '{}', 1)`
    ).run('ev-triage', 'scope-1');

    runMigration160(db);

    db.prepare(
      `INSERT INTO evolution_evidence (id, scope_id, kind, summary, metadata_json, created_at)
       VALUES (?, ?, 'friction_digest', 'new digest', '{}', 2)`
    ).run('ev-digest', 'scope-1');

    const kinds = db.prepare(`SELECT kind FROM evolution_evidence ORDER BY id`).all() as Array<{
      kind: string;
    }>;
    expect(kinds).toEqual([{ kind: 'friction_digest' }, { kind: 'verification_triage' }]);
  });
});
