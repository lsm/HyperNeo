import { describe, expect, test } from 'bun:test';
import { runMigration273 } from '../../../../../src/storage/schema/m273-backfill-agent-session-ids.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE space_long_horizon_agents (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    session_id TEXT DEFAULT NULL
  )`);
  return db;
}

function sessionIdOf(db: BunDatabase, agentId: string): string | null {
  return (
    db.prepare(`SELECT session_id FROM space_long_horizon_agents WHERE id = ?`).get(agentId) as {
      session_id: string | null;
    }
  ).session_id;
}

describe('migration 273: backfill agent session ids', () => {
  test('records the existing derived session on an agent that lacks one', () => {
    const db = makeDb();
    db.exec(`INSERT INTO space_long_horizon_agents (id, space_id) VALUES ('agent-1', 'space-1')`);
    db.exec(`INSERT INTO sessions (id) VALUES ('space:agent:space-1:agent-1')`);

    runMigration273(db);

    expect(sessionIdOf(db, 'agent-1')).toBe('space:agent:space-1:agent-1');
  });

  test('leaves an agent without a session, or with one already recorded, untouched', () => {
    const db = makeDb();
    db.exec(`INSERT INTO space_long_horizon_agents (id, space_id) VALUES ('agent-new', 'space-1')`);
    db.exec(
      `INSERT INTO space_long_horizon_agents (id, space_id, session_id) VALUES ('agent-set', 'space-1', 'custom-session')`
    );
    db.exec(`INSERT INTO sessions (id) VALUES ('space:agent:space-1:agent-set')`);

    runMigration273(db);

    expect(sessionIdOf(db, 'agent-new')).toBeNull();
    expect(sessionIdOf(db, 'agent-set')).toBe('custom-session');
  });

  test('encodes ids the same way the runtime derived them', () => {
    const db = makeDb();
    db.exec(`INSERT INTO space_long_horizon_agents (id, space_id) VALUES ('agent 2', 'space/2')`);
    db.exec(`INSERT INTO sessions (id) VALUES ('space:agent:space%2F2:agent%202')`);

    runMigration273(db);

    expect(sessionIdOf(db, 'agent 2')).toBe('space:agent:space%2F2:agent%202');
  });

  test('is a no-op when the tables do not exist yet', () => {
    const db = new BunDatabase(':memory:');
    expect(() => runMigration273(db)).not.toThrow();
  });
});
