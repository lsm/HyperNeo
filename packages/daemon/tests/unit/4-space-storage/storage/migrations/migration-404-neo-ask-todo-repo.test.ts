import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration404 } from '../../../../../src/storage/schema/m404-neo-ask-todo-repo.ts';

describe('runMigration404', () => {
  test('adds a repo column to asks and todos once, keeping their rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_asks(id TEXT PRIMARY KEY);
        CREATE TABLE neo_todos(id TEXT PRIMARY KEY);
        INSERT INTO neo_asks VALUES ('a');
        INSERT INTO neo_todos VALUES ('t');`);
      runMigration404(db);
      runMigration404(db);
      for (const table of ['neo_asks', 'neo_todos'])
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([
          { id: table === 'neo_asks' ? 'a' : 't', repo: null },
        ]);
    } finally {
      db.close();
    }
  });
});
