import { describe, expect, mock, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../../src/storage/schema';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../../src/storage/repositories/space-task-repository';
import { readTaskCore } from '../../../../../src/storage/tasks/task-reader';

function previousDatabase() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    "CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO migration_markers VALUES ('migration_241', 1)"
  );
  runMigrations(db, () => {});
  createTables(db);
  db.exec("DELETE FROM migration_markers WHERE key = 'migration_241'");
  return db;
}

function ownershipColumn(db: Database) {
  return (
    db.prepare('PRAGMA table_info(space_tasks)').all() as Array<{ name: string; notnull: number }>
  ).find((column) => column.name === 'space_id');
}

function insertStandalone(db: Database) {
  db.exec(
    "INSERT INTO space_tasks (id, title, status, created_at, updated_at) VALUES ('standalone', 'Independent', 'open', 1, 1)"
  );
}

describe('startup task ownership migration', () => {
  test('backs up before upgrade, preserves Space tasks, and survives restart with standalone data', () => {
    const db = previousDatabase();
    try {
      expect(ownershipColumn(db)?.notnull).toBe(1);
      const spaces = new SpaceRepository(db);
      const space = spaces.createSpace({
        name: 'Test',
        slug: 'test',
        workspacePath: '/workspace/test',
      });
      const tasks = new SpaceTaskRepository(db);
      const original = tasks.createTask({ spaceId: space.id, title: 'Existing', description: '' });
      const backup = mock(() => {
        expect(ownershipColumn(db)?.notnull).toBe(1);
        expect(tasks.getTask(original.id)).toEqual(original);
      });
      runMigrations(db, backup);
      expect(backup).toHaveBeenCalledTimes(1);
      expect(ownershipColumn(db)?.notnull).toBe(0);
      expect(
        db.prepare("SELECT key FROM migration_markers WHERE key = 'migration_241'").get()
      ).toEqual({ key: 'migration_241' });
      expect(tasks.getTask(original.id)).toEqual(original);
      insertStandalone(db);
      expect(tasks.getTask('standalone')).toBeNull();
      expect(readTaskCore(db, 'standalone')).toMatchObject({
        id: 'standalone',
        title: 'Independent',
      });
      const restartBackup = mock(() => {});
      runMigrations(db, restartBackup);
      createTables(db);
      expect(restartBackup).not.toHaveBeenCalled();
      expect(readTaskCore(db, 'standalone')).toMatchObject({ id: 'standalone' });
      expect(
        tasks.createTask({ spaceId: space.id, title: 'Next', description: '' }).taskNumber
      ).toBe(original.taskNumber + 1);
      db.prepare('DELETE FROM spaces WHERE id = ?').run(space.id);
      expect(tasks.getTask(original.id)).toBeNull();
      expect(readTaskCore(db, 'standalone')).not.toBeNull();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('fresh startup produces the same ownership constraints', () => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      runMigrations(db, () => {});
      createTables(db);
      insertStandalone(db);
      expect(ownershipColumn(db)?.notnull).toBe(0);
      expect(() =>
        db.exec("UPDATE space_tasks SET task_number = 1 WHERE id = 'standalone'")
      ).toThrow();
      expect(() =>
        db.exec("UPDATE space_tasks SET task_agent_session_id = 'session' WHERE id = 'standalone'")
      ).toThrow();
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
