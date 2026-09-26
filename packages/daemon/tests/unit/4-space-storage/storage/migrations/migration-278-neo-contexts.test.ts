import { describe, expect, test } from 'bun:test';
import { runMigration278 } from '../../../../../src/storage/schema/m278-neo-contexts.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 278: Neo contexts', () => {
  test('creates the isolated tables idempotently without changing existing sessions', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
      db.exec("INSERT INTO sessions VALUES ('existing', 'Keep me')");
      runMigration278(db);
      db.exec("INSERT INTO neo_concerns VALUES ('launch', 'Launch', '', '', 1, 1, 1)");
      runMigration278(db);
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual([
        { id: 'existing', title: 'Keep me' },
      ]);
      expect(db.prepare('SELECT id FROM neo_concerns').all()).toEqual([{ id: 'launch' }]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'neo_%' ORDER BY name"
          )
          .all()
      ).toEqual([{ name: 'neo_concerns' }, { name: 'neo_session_bindings' }, { name: 'neo_work' }]);
    } finally {
      db.close();
    }
  });
});
