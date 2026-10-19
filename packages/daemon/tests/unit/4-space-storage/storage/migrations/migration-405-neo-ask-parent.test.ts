import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration405 } from '../../../../../src/storage/schema/m405-neo-ask-parent.ts';

describe('runMigration405', () => {
  test('adds a parent link to asks once, keeping their rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE neo_asks(id TEXT PRIMARY KEY); INSERT INTO neo_asks VALUES ('a');");
      runMigration405(db);
      runMigration405(db);
      expect(db.prepare('SELECT * FROM neo_asks').all()).toEqual([{ id: 'a', parent_id: null }]);
    } finally {
      db.close();
    }
  });
});
