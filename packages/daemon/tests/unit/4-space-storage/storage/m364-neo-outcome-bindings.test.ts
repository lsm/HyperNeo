import { describe, expect, test } from 'bun:test';
import { runMigration364 } from '../../../../src/storage/schema/m364-neo-outcome-bindings';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration364', () => {
  test('upgrades old items without inventing bindings and safely reruns', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE neo_work (id TEXT PRIMARY KEY); INSERT INTO neo_work VALUES ('w1')");
      db.exec(
        "CREATE TABLE neo_ask_items (id TEXT PRIMARY KEY, evidence TEXT); INSERT INTO neo_ask_items VALUES ('i1', 'proof')"
      );
      runMigration364(db);
      expect(db.prepare('SELECT * FROM neo_ask_items').get()).toEqual({
        id: 'i1',
        evidence: 'proof',
        delivered_by: null,
      });
      db.exec("UPDATE neo_ask_items SET delivered_by = 'w1'");
      runMigration364(db);
      expect(db.prepare('SELECT delivered_by FROM neo_ask_items').get()).toEqual({
        delivered_by: 'w1',
      });
    } finally {
      db.close();
    }
  });
  test('does not create a competing item table in a database without Neo', () => {
    const db = new Database(':memory:');
    try {
      runMigration364(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});
