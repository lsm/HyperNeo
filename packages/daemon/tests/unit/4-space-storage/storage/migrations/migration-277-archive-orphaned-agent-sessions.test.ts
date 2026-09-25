import { describe, expect, test } from 'bun:test';
import { runMigration277 } from '../../../../../src/storage/schema/m277-archive-orphaned-agent-sessions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, space_id TEXT, status TEXT NOT NULL DEFAULT 'active', archived_at TEXT, metadata TEXT)`
  );
  db.exec(`CREATE TABLE space_long_horizon_agents (id TEXT PRIMARY KEY)`);
  db.exec(`INSERT INTO space_long_horizon_agents VALUES ('live')`);
  return db;
}

function insert(db: BunDatabase, id: string, spaceId: string | null, agentId: string | null) {
  const metadata = agentId ? JSON.stringify({ promptProvenance: { agentId } }) : '{}';
  db.prepare(`INSERT INTO sessions (id, space_id, metadata) VALUES (?, ?, ?)`).run(
    id,
    spaceId,
    metadata
  );
}

function status(db: BunDatabase, id: string) {
  return db.prepare(`SELECT status, archived_at FROM sessions WHERE id = ?`).get(id) as {
    status: string;
    archived_at: string | null;
  };
}

describe('migration 277: archive sessions whose agent no longer exists', () => {
  test('archives a space session stamped with a deleted agent', () => {
    const db = makeDb();
    insert(db, 'orphan', 'space-1', 'gone');

    runMigration277(db, '2026-09-24T00:00:00.000Z');

    expect(status(db, 'orphan')).toEqual({
      status: 'archived',
      archived_at: '2026-09-24T00:00:00.000Z',
    });
  });

  test('leaves sessions of live agents, unstamped sessions, and non-space sessions alone', () => {
    const db = makeDb();
    insert(db, 'owned', 'space-1', 'live');
    insert(db, 'plain', 'space-1', null);
    insert(db, 'chat', null, 'gone');

    runMigration277(db);

    expect(status(db, 'owned').status).toBe('active');
    expect(status(db, 'plain').status).toBe('active');
    expect(status(db, 'chat').status).toBe('active');
  });
});
