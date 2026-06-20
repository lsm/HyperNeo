import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigration159 } from '../../../../../src/storage/schema/migrations';

describe('Migration 159: add friction_digest evidence kind', () => {
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
          CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error', 'daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception', 'error_cluster', 'retry_loop', 'tool_failure', 'test_failure', 'permission_block', 'slow_tool_call', 'conversation_friction')),
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

  test('widens evolution_evidence CHECK to accept friction_digest', () => {
    db.prepare(
      `INSERT INTO evolution_evidence (id, scope_id, kind, summary, metadata_json, created_at)
       VALUES (?, ?, 'task', 'existing evidence', '{}', 1)`
    ).run('ev-1', 'scope-1');

    runMigration159(db);

    const existing = db
      .prepare(`SELECT id, kind FROM evolution_evidence WHERE id = ?`)
      .get('ev-1') as { id: string; kind: string };
    expect(existing).toEqual({ id: 'ev-1', kind: 'task' });

    db.prepare(
      `INSERT INTO evolution_evidence (id, scope_id, kind, summary, metadata_json, created_at)
       VALUES (?, ?, 'friction_digest', 'new digest', '{}', 2)`
    ).run('ev-2', 'scope-1');

    const digest = db.prepare(`SELECT kind FROM evolution_evidence WHERE id = ?`).get('ev-2') as {
      kind: string;
    };
    expect(digest.kind).toBe('friction_digest');
  });

  test('is idempotent when CHECK already includes friction_digest', () => {
    db.exec(`
      CREATE TABLE evolution_evidence_new (
        id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL
          CHECK(kind IN ('task', 'workflow_run', 'session', 'manual_note', 'metric_snapshot', 'task_result', 'artifact', 'error', 'daemon_error', 'runtime_crash', 'runtime_warning', 'uncaught_exception', 'error_cluster', 'retry_loop', 'tool_failure', 'test_failure', 'permission_block', 'slow_tool_call', 'conversation_friction', 'friction_digest')),
        summary TEXT NOT NULL,
        source_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES evolution_scopes(id) ON DELETE CASCADE
      )
    `);
    db.exec(`INSERT INTO evolution_evidence_new SELECT * FROM evolution_evidence`);
    db.exec(`DROP TABLE evolution_evidence`);
    db.exec(`ALTER TABLE evolution_evidence_new RENAME TO evolution_evidence`);

    runMigration159(db);

    db.prepare(
      `INSERT INTO evolution_evidence (id, scope_id, kind, summary, metadata_json, created_at)
       VALUES (?, ?, 'friction_digest', 'digest', '{}', 1)`
    ).run('ev-3', 'scope-1');

    const row = db.prepare(`SELECT kind FROM evolution_evidence WHERE id = ?`).get('ev-3') as {
      kind: string;
    };
    expect(row.kind).toBe('friction_digest');
  });
});
