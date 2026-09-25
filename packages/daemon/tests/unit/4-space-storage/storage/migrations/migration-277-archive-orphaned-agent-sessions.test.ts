import { describe, expect, test } from 'bun:test';
import { runMigration277 } from '../../../../../src/storage/schema/m277-archive-orphaned-agent-sessions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

const GONE = '11111111-2222-4333-8444-555555555555';
const LIVE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ARCHIVED = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT, status TEXT NOT NULL DEFAULT 'active', archived_at TEXT, metadata TEXT, type TEXT DEFAULT 'worker', session_context TEXT)`
  );
  db.exec(
    `CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active')`
  );
  db.exec(`INSERT INTO space_long_horizon_agents VALUES ('${LIVE}', 'active')`);
  db.exec(`INSERT INTO space_long_horizon_agents VALUES ('${ARCHIVED}', 'archived')`);
  return db;
}

function insert(
  db: BunDatabase,
  id: string,
  spaceId: string | null,
  agentId: string | null,
  extra: { type?: string; context?: Record<string, unknown> } = {}
) {
  const metadata = agentId ? JSON.stringify({ promptProvenance: { agentId } }) : '{}';
  db.prepare(
    `INSERT INTO sessions (id, space_id, metadata, type, session_context) VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    spaceId,
    metadata,
    extra.type ?? 'worker',
    extra.context ? JSON.stringify(extra.context) : null
  );
}

function status(db: BunDatabase, id: string) {
  return (db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(id) as { status: string })
    .status;
}

describe('migration 277: archive sessions whose agent no longer exists', () => {
  test('archives a space session stamped with a deleted agent', () => {
    const db = makeDb();
    insert(db, 'orphan', 'space-1', GONE);

    runMigration277(db, '2026-09-24T00:00:00.000Z');

    expect(
      db.prepare(`SELECT status, archived_at FROM sessions WHERE id = 'orphan'`).get()
    ).toEqual({ status: 'archived', archived_at: '2026-09-24T00:00:00.000Z' });
  });

  test('archives the still-active session of an agent archived before this migration', () => {
    const db = makeDb();
    insert(db, 'stale', 'space-1', ARCHIVED);

    runMigration277(db);

    expect(status(db, 'stale')).toBe('archived');
  });

  test('leaves sessions of live agents, unstamped sessions, and non-space sessions alone', () => {
    const db = makeDb();
    insert(db, 'owned', 'space-1', LIVE);
    insert(db, 'plain', 'space-1', null);
    insert(db, 'chat', null, GONE);

    runMigration277(db);

    expect(status(db, 'owned')).toBe('active');
    expect(status(db, 'plain')).toBe('active');
    expect(status(db, 'chat')).toBe('active');
  });

  test('skips template-keyed provenance, task agent sessions, and task-context sessions', () => {
    const db = makeDb();
    insert(db, 'slot', 'space-1', 'worker');
    insert(db, 'synthetic', 'space-1', 'template:worker');
    insert(db, 'task-agent', 'space-1', GONE, { type: 'space_task_agent' });
    insert(db, 'space:s:task:t:exec:1', 'space-1', GONE);
    insert(db, 'task-ctx', 'space-1', GONE, { context: { taskId: 't1' } });

    runMigration277(db);

    for (const id of ['slot', 'synthetic', 'task-agent', 'space:s:task:t:exec:1', 'task-ctx']) {
      expect(status(db, id)).toBe('active');
    }
  });

  test('is a no-op on a sessions table without the metadata column', () => {
    const db = new BunDatabase(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT, status TEXT)`);
    db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY, status TEXT)`);
    db.exec(`INSERT INTO sessions VALUES ('s', 'space-1', 'active')`);

    runMigration277(db);

    expect(status(db, 's')).toBe('active');
  });
});
