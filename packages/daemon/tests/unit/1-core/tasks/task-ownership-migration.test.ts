import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { migrateStandaloneTaskOwnership } from '../../../../src/storage/tasks/ownership-migration';
import { createTestDb } from '../../../helpers/database';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';

const schema = `CREATE TABLE spaces (id TEXT PRIMARY KEY);
CREATE TABLE space_tasks (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, task_number INTEGER NOT NULL,
  title TEXT NOT NULL, workflow_run_id TEXT, preferred_workflow_id TEXT,
  goal_id TEXT, evolution_scope_id TEXT, workspace_path TEXT,
  task_agent_session_id TEXT, post_approval_session_id TEXT,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX task_numbers ON space_tasks(space_id, task_number);
CREATE INDEX task_titles ON space_tasks(lower(title)) WHERE title != '';
CREATE TABLE children (id TEXT PRIMARY KEY, task_id TEXT REFERENCES space_tasks(id) ON DELETE CASCADE);
CREATE TABLE audit (title TEXT);
CREATE TRIGGER task_title_audit AFTER UPDATE OF title ON space_tasks BEGIN INSERT INTO audit VALUES (NEW.title); END;
CREATE VIEW task_view AS SELECT id, title FROM space_tasks;
INSERT INTO spaces VALUES ('space');
INSERT INTO space_tasks (id, space_id, task_number, title) VALUES ('task', 'space', 7, 'Work');
INSERT INTO children VALUES ('child', 'task');`;

describe('standalone task ownership migration', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(schema);
  });
  afterEach(() => db.close());

  test('preserves data, indexes, triggers, views and cascading child references', () => {
    const rows = db.prepare('SELECT * FROM space_tasks').all();
    const objects = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_tasks' AND type IN ('index', 'trigger') ORDER BY name"
      )
      .all();
    migrateStandaloneTaskOwnership(db);
    expect(db.prepare('SELECT * FROM space_tasks').all()).toEqual(rows);
    expect(
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE tbl_name = 'space_tasks' AND type IN ('index', 'trigger') ORDER BY name"
        )
        .all()
    ).toEqual(objects);
    expect(db.prepare('SELECT * FROM children').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM task_view').all()).toEqual([{ id: 'task', title: 'Work' }]);
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([]);
    db.exec("UPDATE space_tasks SET title = 'Changed' WHERE id = 'task'");
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([{ title: 'Changed' }]);
    expect(() =>
      db.exec(
        "INSERT INTO space_tasks (id, space_id, task_number, title) VALUES ('duplicate', 'space', 7, 'Other')"
      )
    ).toThrow();
    db.exec("INSERT INTO space_tasks (id, title) VALUES ('standalone', 'Independent')");
    db.exec("DELETE FROM spaces WHERE id = 'space'");
    expect(db.prepare('SELECT id FROM space_tasks').all()).toEqual([{ id: 'standalone' }]);
    expect(db.prepare('SELECT * FROM children').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  test('is repeatable and restores disabled foreign keys and legacy-alter settings', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA legacy_alter_table = ON');
    migrateStandaloneTaskOwnership(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'space_tasks'").get();
    migrateStandaloneTaskOwnership(db);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'space_tasks'").get()).toEqual(
      table
    );
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 });
    expect(db.prepare('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 1 });
  });

  test('rolls back a failed rebuild without losing original data or schema', () => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO children VALUES ('orphan', 'absent')");
    db.exec('PRAGMA foreign_keys = ON');
    const before = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    expect(() => migrateStandaloneTaskOwnership(db)).toThrow('foreign-key violations');
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before
    );
    expect(db.prepare('SELECT id FROM space_tasks').all()).toEqual([{ id: 'task' }]);
    expect(db.prepare('SELECT * FROM children').all()).toHaveLength(2);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA legacy_alter_table').get()).toEqual({ legacy_alter_table: 0 });
  });

  test('rejects caller-owned transactions without rolling them back', () => {
    db.exec('BEGIN');
    db.exec("INSERT INTO audit VALUES ('caller')");
    expect(() => migrateStandaloneTaskOwnership(db)).toThrow('active transaction');
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([{ title: 'caller' }]);
    db.exec('ROLLBACK');
    expect(db.prepare('SELECT * FROM audit').all()).toEqual([]);
  });

  test('rebuilds the current full schema and preserves Space task creation and numbering', async () => {
    const full = await createTestDb();
    try {
      const spaces = new SpaceRepository(full.getDatabase());
      const space = spaces.createSpace({
        name: 'Test',
        slug: 'test',
        workspacePath: '/workspace/test',
      });
      const tasks = new SpaceTaskRepository(full.getDatabase());
      const first = tasks.createTask({ spaceId: space.id, title: 'First', description: '' });
      migrateStandaloneTaskOwnership(full.getDatabase());
      expect(tasks.getTask(first.id)).toEqual(first);
      const second = tasks.createTask({ spaceId: space.id, title: 'Second', description: '' });
      expect(second.taskNumber).toBe(first.taskNumber + 1);
      expect(full.getDatabase().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      full.close();
    }
  });
});
