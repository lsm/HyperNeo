import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';
import { runMigration157 } from '../../../../../src/storage/schema/migrations';

describe('Migration 157: archive terminal Space task worker sessions', () => {
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
        task_agent_session_id TEXT
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

  function insertSession(id: string, taskId: string | null, type = 'worker'): void {
    db.prepare(
      `INSERT INTO sessions (id, status, archived_at, type, session_context)
       VALUES (?, 'active', NULL, ?, ?)`
    ).run(id, type, taskId ? JSON.stringify({ taskId }) : null);
    db.prepare(
      `INSERT INTO message_search_content (kind, source_id, session_id)
       VALUES ('message', ?, ?)`
    ).run(`msg-${id}`, id);
  }

  test('archives worker sessions linked to done, cancelled, or archived tasks', () => {
    db.prepare(`INSERT INTO space_tasks (id, status, task_agent_session_id) VALUES (?, ?, ?)`).run(
      'task-done',
      'done',
      'task-agent-session'
    );
    db.prepare(`INSERT INTO space_tasks (id, status, task_agent_session_id) VALUES (?, ?, ?)`).run(
      'task-open',
      'open',
      null
    );
    insertSession('context-linked', 'task-done');
    insertSession('space:x:task:task-done:exec:node-1', null);
    insertSession('task-agent-session', null);
    insertSession('open-session', 'task-open');
    insertSession('space-chat-session', 'task-done', 'space_chat');

    runMigration157(db);

    const rows = db
      .prepare(`SELECT id, status, archived_at FROM sessions ORDER BY id`)
      .all() as Array<{ id: string; status: string; archived_at: string | null }>;
    expect(rows).toEqual([
      { id: 'context-linked', status: 'archived', archived_at: expect.any(String) },
      { id: 'open-session', status: 'active', archived_at: null },
      { id: 'space-chat-session', status: 'active', archived_at: null },
      {
        id: 'space:x:task:task-done:exec:node-1',
        status: 'archived',
        archived_at: expect.any(String),
      },
      { id: 'task-agent-session', status: 'archived', archived_at: expect.any(String) },
    ]);
    const remainingSearchRows = db
      .prepare(`SELECT session_id FROM message_search_content ORDER BY session_id`)
      .all() as Array<{ session_id: string }>;
    expect(remainingSearchRows.map((row) => row.session_id)).toEqual([
      'open-session',
      'space-chat-session',
    ]);
  });

  test('is idempotent', () => {
    db.prepare(`INSERT INTO space_tasks (id, status, task_agent_session_id) VALUES (?, ?, ?)`).run(
      'task-done',
      'done',
      null
    );
    insertSession('context-linked', 'task-done');

    runMigration157(db);
    expect(() => runMigration157(db)).not.toThrow();
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM migration_markers`).get() as { count: number }
    ).toEqual({ count: 1 });
  });
});
