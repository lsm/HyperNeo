import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration434 } from '../../../../../src/storage/schema/m434-neo-todo-artifacts.ts';

describe('Todo artifact references upgrade', () => {
  test('keeps existing todo evidence through repeat upgrades and adds no references', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_todos(id TEXT PRIMARY KEY, title TEXT, evidence TEXT);
        INSERT INTO neo_todos VALUES ('todo', 'Report', 'Read the report')`);
      runMigration434(db);
      runMigration434(db);
      expect(db.prepare('SELECT * FROM neo_todos').get()).toEqual({
        id: 'todo',
        title: 'Report',
        evidence: 'Read the report',
        artifacts_json: null,
      });
    } finally {
      db.close();
    }
  });
});
