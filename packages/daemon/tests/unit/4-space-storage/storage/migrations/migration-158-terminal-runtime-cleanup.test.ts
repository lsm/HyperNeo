import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration158 } from '../../../../../src/storage/schema/migrations';

describe('Migration 158: cleanup terminal Space runtime state', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        archived_at TEXT,
        type TEXT,
        session_context TEXT
      );
      CREATE TABLE space_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        task_agent_session_id TEXT,
        workflow_run_id TEXT
      );
      CREATE TABLE space_workflow_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE node_executions (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        agent_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE message_search_content (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        session_id TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function insertSession(id: string, taskId: string | null, type: string): void {
    db.prepare(
      `INSERT INTO sessions (id, status, archived_at, type, session_context)
       VALUES (?, 'active', NULL, ?, ?)`
    ).run(id, type, taskId ? JSON.stringify({ taskId }) : null);
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, session_id)
       VALUES ('message', ?, ?)`
    ).run(`msg-${id}`, id);
  }

  test('archives legacy role sessions linked to terminal tasks', () => {
    db.prepare(
      `INSERT INTO space_tasks (id, status, task_agent_session_id, workflow_run_id)
       VALUES (?, ?, ?, ?)`
    ).run('task-done', 'done', 'direct-session', 'run-done');

    insertSession('leader-session', 'task-done', 'leader');
    insertSession('space:x:task:task-done:exec:node-1', null, 'coder');
    insertSession('direct-session', null, 'space_task_agent');
    insertSession('chat-session', 'task-done', 'space_chat');

    runMigration158(db);

    const rows = db.prepare(`SELECT id, status FROM sessions ORDER BY id`).all() as Array<{
      id: string;
      status: string;
    }>;
    expect(rows).toEqual([
      { id: 'chat-session', status: 'active' },
      { id: 'direct-session', status: 'archived' },
      { id: 'leader-session', status: 'archived' },
      { id: 'space:x:task:task-done:exec:node-1', status: 'archived' },
    ]);
    expect(
      db.prepare(`SELECT session_id FROM message_search_content ORDER BY session_id`).all()
    ).toEqual([{ session_id: 'chat-session' }]);
  });

  test('closes active node executions for terminal workflow runs', () => {
    db.prepare(`INSERT INTO space_workflow_runs (id, status) VALUES (?, ?)`).run(
      'run-done',
      'done'
    );
    db.prepare(`INSERT INTO space_workflow_runs (id, status) VALUES (?, ?)`).run(
      'run-cancelled',
      'cancelled'
    );
    db.prepare(`INSERT INTO space_workflow_runs (id, status) VALUES (?, ?)`).run(
      'run-active',
      'in_progress'
    );
    const insertExecution = db.prepare(
      `INSERT INTO node_executions
       (id, workflow_run_id, status, agent_session_id, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 10, 20, NULL)`
    );
    insertExecution.run('exec-done', 'run-done', 'in_progress', 'session-done');
    insertExecution.run('exec-cancelled', 'run-cancelled', 'blocked', 'session-cancelled');
    insertExecution.run('exec-active', 'run-active', 'in_progress', 'session-active');

    runMigration158(db);

    const rows = db
      .prepare(`SELECT id, status, completed_at FROM node_executions ORDER BY id`)
      .all() as Array<{ id: string; status: string; completed_at: number | null }>;
    expect(rows).toEqual([
      { id: 'exec-active', status: 'in_progress', completed_at: null },
      { id: 'exec-cancelled', status: 'cancelled', completed_at: 20 },
      { id: 'exec-done', status: 'done', completed_at: 20 },
    ]);
  });
});
