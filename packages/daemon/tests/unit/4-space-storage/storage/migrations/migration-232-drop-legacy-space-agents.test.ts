import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration232 } from '../../../../../src/storage/schema/m232-drop-legacy-space-agents.ts';
import { Database as BunDatabase } from '../../../../../src/storage/sqlite-compat.ts';
import { createLegacySpaceAgentTables } from '../../../helpers/space-agent-schema.ts';

const LEGACY_TABLES = [
  'space_agents',
  'space_agent_goal_assignments',
  'space_agent_forge_scope_assignments',
  'space_agent_reminders',
];

function tableExists(db: BunDatabase, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function makeRecreatedLegacyDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createLegacySpaceAgentTables(db);
  return db;
}

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, id, `/tmp/${id}`, id);
}

function insertWorker(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 10, 10)`
  ).run(id, spaceId, id, id);
}

function insertLongHorizonAgent(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents (
       id, space_id, handle, display_name, template_key, status, instructions,
       tool_permissions_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'migration.legacy_space_agent', 'active', '', '{}', 10, 10)`
  ).run(id, spaceId, id, id);
}

describe('migration 232 — drop legacy space agent tables', () => {
  test('drops all four legacy tables when every worker row is copied', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertWorker(db, 'worker-1', 'space-a');
    insertLongHorizonAgent(db, 'worker-1', 'space-a');

    runMigration232(db);

    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    expect(tableExists(db, 'space_long_horizon_agents')).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agents`).get()).toEqual({
      count: 1,
    });
    db.close();
  });

  test('drops the legacy tables even when a worker row has no unified counterpart', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertWorker(db, 'uncopied-worker', 'space-a');

    expect(() => runMigration232(db)).not.toThrow();
    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    db.close();
  });

  test('drops when a same-id row lives in another space, leaving the unified row untouched', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertSpace(db, 'space-b');
    insertWorker(db, 'shared-id', 'space-a');
    insertLongHorizonAgent(db, 'shared-id', 'space-b');

    expect(() => runMigration232(db)).not.toThrow();
    expect(tableExists(db, 'space_agents')).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agents`).get()).toEqual({
      count: 1,
    });
    db.close();
  });

  test('drops a live-agent ghost assignment without mutating the unified side', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertWorker(db, 'worker-1', 'space-a');
    insertLongHorizonAgent(db, 'worker-1', 'space-a');
    db.prepare(
      `INSERT INTO space_goals (id, space_id, title, description, created_at, updated_at)
       VALUES ('goal-1', 'space-a', 'Goal', '', 10, 10)`
    ).run();
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES ('space-a', 'worker-1', 'goal-1', 10)`
    ).run();

    runMigration232(db);

    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agent_goals`).get()
    ).toEqual({ count: 0 });
    db.close();
  });

  test('leaves unified assignment rows untouched by the drop', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertWorker(db, 'worker-1', 'space-a');
    insertLongHorizonAgent(db, 'worker-1', 'space-a');
    db.prepare(
      `INSERT INTO space_goals (id, space_id, title, description, created_at, updated_at)
       VALUES ('goal-1', 'space-a', 'Goal', '', 10, 10)`
    ).run();
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES ('space-a', 'worker-1', 'goal-1', 10)`
    ).run();
    db.prepare(
      `INSERT INTO space_long_horizon_agent_goals (agent_id, goal_id, relationship, created_at, updated_at)
       VALUES ('worker-1', 'goal-1', 'owner', 10, 10)`
    ).run();

    runMigration232(db);

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agent_goals`).get()
    ).toEqual({ count: 1 });
    db.close();
  });

  test('drops assignment ghosts whose goal no longer exists', () => {
    const db = makeRecreatedLegacyDb();
    insertSpace(db, 'space-a');
    insertWorker(db, 'worker-1', 'space-a');
    insertLongHorizonAgent(db, 'worker-1', 'space-a');
    db.prepare(
      `INSERT INTO space_agent_goal_assignments (space_id, agent_id, goal_id, created_at)
       VALUES ('space-a', 'worker-1', 'deleted-goal', 10)`
    ).run();

    runMigration232(db);

    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM space_long_horizon_agent_goals`).get()
    ).toEqual({ count: 0 });
    db.close();
  });

  test('is a no-op on a database that no longer has space_agents', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});

    expect(() => runMigration232(db)).not.toThrow();
    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    db.close();
  });

  test('fresh install replays history, drops the legacy tables, and never recreates them', () => {
    const db = new BunDatabase(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, () => {});
    createTables(db);
    createTables(db);

    expect(
      db.prepare(`SELECT 1 FROM migration_markers WHERE key = 'migration_232'`).get()
    ).toBeDefined();
    for (const table of LEGACY_TABLES) {
      expect(tableExists(db, table)).toBe(false);
    }
    expect(tableExists(db, 'space_long_horizon_agents')).toBe(true);
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db.close();
  });
});
