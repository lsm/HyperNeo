import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration406 } from '../../../../../src/storage/schema/m406-goal-owner-session.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';

const OLD_SCHEMA = `
  CREATE TABLE spaces (id TEXT PRIMARY KEY);
  CREATE TABLE space_tasks (id TEXT PRIMARY KEY);
  CREATE TABLE space_goals (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'paused', 'completed', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
  );
  ALTER TABLE space_goals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_space_goals_space ON space_goals(space_id, status);
  CREATE TABLE space_goal_events (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    goal_id TEXT NOT NULL,
    event_type TEXT NOT NULL
      CHECK(event_type IN ('created', 'updated', 'status_changed', 'task_triggered', 'task_queued', 'task_terminal', 'schedule_updated')),
    source TEXT NOT NULL
      CHECK(source IN ('rpc', 'space_agent_tool', 'workflow_node_agent', 'scheduler', 'system')),
    source_task_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
    FOREIGN KEY (goal_id) REFERENCES space_goals(id) ON DELETE CASCADE,
    FOREIGN KEY (source_task_id) REFERENCES space_tasks(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_space_goal_events_goal_created ON space_goal_events(goal_id, created_at DESC);
  CREATE TABLE space_goal_outcome_notifications (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE);
  CREATE TABLE goal_automation_cursors (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE);
  CREATE TABLE evolution_scopes (id TEXT PRIMARY KEY, space_goal_id TEXT REFERENCES space_goals(id) ON DELETE SET NULL);
  CREATE TABLE space_long_horizon_agent_goals (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE);
  CREATE TABLE space_agent_goal_assignments (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES space_goals(id) ON DELETE CASCADE);
  INSERT INTO spaces VALUES ('s');
  INSERT INTO space_tasks VALUES ('t');
  INSERT INTO space_goals (id, space_id, title, created_at, updated_at, revision) VALUES ('g', 's', 'Ship', 1, 2, 3);
  INSERT INTO space_goal_events VALUES ('e', 's', 'g', 'created', 'rpc', 't', 1);
  INSERT INTO space_goal_outcome_notifications VALUES ('n', 'g');
  INSERT INTO goal_automation_cursors VALUES ('c', 'g');
  INSERT INTO evolution_scopes VALUES ('v', 'g');
  INSERT INTO space_long_horizon_agent_goals VALUES ('l', 'g');
  INSERT INTO space_agent_goal_assignments VALUES ('a', 'g');
`;
const REFERENCING = [
  'space_goal_outcome_notifications',
  'goal_automation_cursors',
  'space_long_horizon_agent_goals',
  'space_agent_goal_assignments',
];

function migrated(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(OLD_SCHEMA);
  runMigration406(db);
  runMigration406(db);
  return db;
}

describe('goal owner-session migration', () => {
  test('keeps Space goals, their events and every row that points at them', () => {
    const db = migrated();
    try {
      expect(
        db.prepare('SELECT id, space_id, title, revision, owner_session_id FROM space_goals').all()
      ).toEqual([{ id: 'g', space_id: 's', title: 'Ship', revision: 3, owner_session_id: null }]);
      expect(db.prepare('SELECT id, goal_id FROM space_goal_events').all()).toEqual([
        { id: 'e', goal_id: 'g' },
      ]);
      for (const table of [...REFERENCING, 'evolution_scopes'])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_space_goal%' ORDER BY name"
          )
          .all()
      ).toEqual([
        { name: 'idx_space_goal_events_goal_created' },
        { name: 'idx_space_goals_space' },
      ]);
    } finally {
      db.close();
    }
  });

  test('a goal belongs to a Space or to an owner session, never both or neither', () => {
    const db = migrated();
    try {
      db.exec(
        "INSERT INTO space_goals (id, owner_session_id, title, created_at, updated_at, done_test) VALUES ('o', 'neo:root', 'Grow', 1, 1, 'Ten adopters')"
      );
      expect(() =>
        db.exec(
          "INSERT INTO space_goals (id, title, created_at, updated_at) VALUES ('x', 'None', 1, 1)"
        )
      ).toThrow();
      expect(() =>
        db.exec(
          "INSERT INTO space_goals (id, space_id, owner_session_id, title, created_at, updated_at) VALUES ('y', 's', 'neo:root', 'Both', 1, 1)"
        )
      ).toThrow();
      db.exec(
        "INSERT INTO space_goal_events (id, goal_id, event_type, source, created_at) VALUES ('j', 'o', 'journal_compacted', 'neo', 2)"
      );
      expect(
        db.prepare("SELECT space_id, source FROM space_goal_events WHERE id = 'j'").get()
      ).toEqual({
        space_id: null,
        source: 'neo',
      });
    } finally {
      db.close();
    }
  });

  test('deleting a goal still cascades to its events and links, and clears evolution scopes', () => {
    const db = migrated();
    try {
      db.exec("DELETE FROM space_goals WHERE id = 'g'");
      for (const table of ['space_goal_events', ...REFERENCING])
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT space_goal_id FROM evolution_scopes').get()).toEqual({
        space_goal_id: null,
      });
    } finally {
      db.close();
    }
  });

  test('a start interrupted after the goal rebuild still rebuilds the events on the next run', () => {
    const db = new Database(':memory:');
    try {
      db.exec(OLD_SCHEMA);
      const events = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'space_goal_events'")
        .get() as { sql: string };
      runMigration406(db);
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('ALTER TABLE space_goal_events RENAME TO done_events');
      db.exec(events.sql);
      db.exec('INSERT INTO space_goal_events SELECT * FROM done_events');
      db.exec('DROP TABLE done_events');
      runMigration406(db);
      db.exec(
        "INSERT INTO space_goal_events (id, goal_id, event_type, source, created_at) VALUES ('j', 'g', 'journal_compacted', 'human', 2)"
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM space_goal_events').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test('a fresh database keeps owner-session goals in standalone storage', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      createTables(db);
      db.exec(
        "INSERT INTO neo_goals (id, owner_session_id, title, created_at, updated_at) VALUES ('o', 'neo:root', 'Grow', 1, 1)"
      );
      expect(db.prepare("SELECT owner_session_id FROM neo_goals WHERE id = 'o'").get()).toEqual({
        owner_session_id: 'neo:root',
      });
    } finally {
      db.close();
    }
  });
});
