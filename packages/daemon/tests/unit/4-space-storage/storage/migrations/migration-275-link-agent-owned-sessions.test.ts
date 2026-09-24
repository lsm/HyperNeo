import { describe, expect, test } from 'bun:test';
import { runMigration275 } from '../../../../../src/storage/schema/m275-link-agent-owned-sessions.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT, metadata TEXT)`);
  db.exec(`CREATE TABLE space_long_horizon_agents (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    session_id TEXT
  )`);
  return db;
}

function session(db: BunDatabase, id: string) {
  const row = db.prepare(`SELECT type, metadata FROM sessions WHERE id = ?`).get(id) as {
    type: string;
    metadata: string;
  };
  return { type: row.type, provenance: JSON.parse(row.metadata).promptProvenance };
}

describe('migration 275: link agent-owned sessions to their agent', () => {
  test('stamps the owning agent on a legacy chat session and makes it a worker session', () => {
    const db = makeDb();
    db.exec(`INSERT INTO sessions VALUES ('space:chat:s1', 'space_chat', '{}')`);
    db.exec(
      `INSERT INTO space_long_horizon_agents VALUES ('a1', 'coordinator', 'active', 'space:chat:s1')`
    );

    runMigration275(db);

    expect(session(db, 'space:chat:s1')).toEqual({
      type: 'worker',
      provenance: { source: 'linked_session', hash: 'a1', agentId: 'a1', agentName: 'coordinator' },
    });
  });

  test('leaves already linked sessions and archived agents alone', () => {
    const db = makeDb();
    const linked = JSON.stringify({ promptProvenance: { source: 'x', hash: 'h', agentId: 'a1' } });
    db.prepare(`INSERT INTO sessions VALUES ('s-linked', 'worker', ?)`).run(linked);
    db.exec(`INSERT INTO sessions VALUES ('s-old', 'worker', '{}')`);
    db.exec(`INSERT INTO space_long_horizon_agents VALUES ('a1', 'one', 'active', 's-linked')`);
    db.exec(`INSERT INTO space_long_horizon_agents VALUES ('a2', 'two', 'archived', 's-old')`);

    runMigration275(db);

    expect(session(db, 's-linked').provenance).toEqual({ source: 'x', hash: 'h', agentId: 'a1' });
    expect(session(db, 's-old').provenance).toBeUndefined();
  });
});
