import { describe, expect, test } from 'bun:test';
import { runMigration274 } from '../../../../../src/storage/schema/m274-convert-ad-hoc-space-sessions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    type TEXT,
    status TEXT NOT NULL,
    metadata TEXT,
    session_context TEXT
  )`);
  db.exec(`CREATE TABLE space_long_horizon_agents (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    session_id TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    description TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`INSERT INTO spaces (id) VALUES ('space-1')`);
  return db;
}

function addSession(
  db: BunDatabase,
  id: string,
  options: {
    title?: string;
    type?: string;
    status?: string;
    context?: object;
    metadata?: object;
  } = {}
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, type, status, metadata, session_context) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options.title ?? 'Session',
    options.type ?? 'worker',
    options.status ?? 'active',
    JSON.stringify(options.metadata ?? {}),
    JSON.stringify(options.context ?? { spaceId: 'space-1' })
  );
}

function agents(db: BunDatabase) {
  return db
    .prepare(
      `SELECT handle, display_name, session_id FROM space_long_horizon_agents ORDER BY handle`
    )
    .all() as Array<{ handle: string; display_name: string; session_id: string }>;
}

function session(db: BunDatabase, id: string) {
  const row = db.prepare(`SELECT type, metadata FROM sessions WHERE id = ?`).get(id) as {
    type: string;
    metadata: string;
  };
  return { type: row.type, metadata: JSON.parse(row.metadata) as Record<string, any> };
}

describe('migration 274: convert ad-hoc Space sessions into agents', () => {
  test('turns an ad-hoc session and an old space chat into agents that own them', () => {
    const db = makeDb();
    addSession(db, 'adhoc-1', { title: 'Fix the build' });
    addSession(db, 'space:chat:space-1', { title: 'Space One', type: 'space_chat' });

    runMigration274(db, 1);

    expect(agents(db)).toEqual([
      { handle: 'fix-the-build', display_name: 'Fix the build', session_id: 'adhoc-1' },
      { handle: 'space-one', display_name: 'Space One', session_id: 'space:chat:space-1' },
    ]);
    const chat = session(db, 'space:chat:space-1');
    expect(chat.type).toBe('worker');
    expect(chat.metadata.promptProvenance.source).toBe('converted_session');
    expect(typeof chat.metadata.promptProvenance.agentId).toBe('string');
  });

  test('leaves agent, task, workflow, archived and non-Space sessions alone', () => {
    const db = makeDb();
    addSession(db, 'space:agent:space-1:a1');
    addSession(db, 'with-agent', { metadata: { promptProvenance: { agentId: 'a2' } } });
    addSession(db, 'with-run', { metadata: { promptProvenance: { workflowRunId: 'r1' } } });
    addSession(db, 'task-worker', { context: { spaceId: 'space-1', taskId: 't1' } });
    addSession(db, 'space:space-1:task:t2');
    addSession(db, 'old', { status: 'archived' });
    addSession(db, 'plain', { context: {} });
    addSession(db, 'lost-space', { context: { spaceId: 'gone' } });

    runMigration274(db, 1);

    expect(agents(db)).toEqual([]);
  });

  test('skips a session an agent already owns and keeps handles unique', () => {
    const db = makeDb();
    db.exec(
      `INSERT INTO space_long_horizon_agents (id, space_id, handle, display_name, session_id, created_at, updated_at)
       VALUES ('a0', 'space-1', 'notes', 'Notes', 'owned', 1, 1)`
    );
    addSession(db, 'owned', { title: 'Notes' });
    addSession(db, 'second', { title: 'Notes' });

    runMigration274(db, 1);

    expect(agents(db).map((agent) => [agent.handle, agent.session_id])).toEqual([
      ['notes', 'owned'],
      ['notes-2', 'second'],
    ]);
  });

  test('is a no-op when the tables do not exist', () => {
    expect(() => runMigration274(new BunDatabase(':memory:'))).not.toThrow();
  });
});
