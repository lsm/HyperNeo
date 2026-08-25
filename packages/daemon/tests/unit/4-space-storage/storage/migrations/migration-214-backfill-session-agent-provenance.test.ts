import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration214 } from '../../../../../src/storage/schema/m214-backfill-session-agent-provenance.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';

let db: BunDatabase;

function insertSession(id: string, type: string, metadata: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, type)
     VALUES (?, ?, '/ws', ?, ?, 'active', '{}', ?, ?)`
  ).run(id, id, now, now, metadata, type);
}

function insertNodeExecution(
  id: string,
  sessionId: string,
  agentName: string,
  nodeId: string
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO node_executions
       (id, workflow_run_id, workflow_node_id, agent_name, agent_session_id, status, created_at, updated_at)
     VALUES (?, 'run-1', ?, ?, ?, 'done', ?, ?)`
  ).run(id, nodeId, agentName, sessionId, now, now);
}

function sessionMetadata(id: string): { promptProvenance?: { agentName?: string } } {
  const row = db.prepare(`SELECT metadata FROM sessions WHERE id = ?`).get(id) as {
    metadata: string;
  };
  return JSON.parse(row.metadata);
}

beforeAll(() => {
  db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  createTables(db);
  runMigrations(db, () => {});
  db.exec('PRAGMA foreign_keys = OFF');
});

afterAll(() => {
  try {
    db.close();
  } catch {}
});

describe('migration 214: backfill session agent provenance', () => {
  test('stamps promptProvenance.agentName on worker sessions missing it', () => {
    insertSession('sess-backfill', 'worker', '{}');
    insertNodeExecution('ne-1', 'sess-backfill', 'coder', 'node-1');
    insertSession(
      'sess-has-name',
      'worker',
      JSON.stringify({ promptProvenance: { agentName: 'qa' } })
    );
    insertNodeExecution('ne-2', 'sess-has-name', 'coder', 'node-2');
    insertSession('sess-no-exec', 'worker', '{}');
    insertSession('sess-not-worker', 'room_chat', '{}');
    insertNodeExecution('ne-3', 'sess-not-worker', 'reviewer', 'node-3');

    runMigration214(db);

    expect(sessionMetadata('sess-backfill').promptProvenance?.agentName).toBe('coder');
    expect(sessionMetadata('sess-has-name').promptProvenance?.agentName).toBe('qa');
    expect(sessionMetadata('sess-no-exec').promptProvenance).toBeUndefined();
    expect(sessionMetadata('sess-not-worker').promptProvenance).toBeUndefined();
  });

  test('is idempotent and safe to rerun', () => {
    runMigration214(db);
    expect(sessionMetadata('sess-backfill').promptProvenance?.agentName).toBe('coder');
  });
});
