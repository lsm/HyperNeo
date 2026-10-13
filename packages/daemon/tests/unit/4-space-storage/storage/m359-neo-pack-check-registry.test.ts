import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration359 } from '../../../../src/storage/schema/m359-neo-pack-check-registry';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE neo_asks (id TEXT PRIMARY KEY);
    INSERT INTO neo_asks VALUES ('a');
    CREATE TABLE neo_ask_items (
      id TEXT PRIMARY KEY, ask_id TEXT REFERENCES neo_asks(id),
      check_kind TEXT CHECK (check_kind IN ('coding.pr_merged', 'life-admin.confirmed')),
      state TEXT CHECK (state IN ('pending', 'met')),
      verified_definition_hash TEXT);
    INSERT INTO neo_ask_items VALUES ('i', 'a', 'life-admin.confirmed', 'met', 'hash');
    CREATE INDEX item_checks ON neo_ask_items(check_kind);
    CREATE TABLE child (item_id TEXT REFERENCES neo_ask_items(id) ON DELETE CASCADE);
    INSERT INTO child VALUES ('i');
    CREATE TABLE audit (id TEXT);
    CREATE TRIGGER item_audit AFTER INSERT ON neo_ask_items BEGIN INSERT INTO audit VALUES (NEW.id); END;
  `);
  return db;
}

describe('runMigration359', () => {
  test('preserves rows, hashes, foreign keys, indexes, triggers and unrelated constraints', () => {
    const db = fixture();
    try {
      runMigration359(db);
      runMigration359(db);
      expect(db.prepare('SELECT * FROM neo_ask_items').get()).toEqual({
        id: 'i',
        ask_id: 'a',
        check_kind: 'life-admin.confirmed',
        state: 'met',
        verified_definition_hash: 'hash',
      });
      expect(db.prepare('SELECT * FROM child').all()).toEqual([{ item_id: 'i' }]);
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.exec("INSERT INTO neo_ask_items VALUES ('j','a','legal.confirmed','pending',NULL)");
      expect(db.prepare('SELECT * FROM audit').all()).toEqual([{ id: 'j' }]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'item_checks'").get()).toEqual(
        { name: 'item_checks' }
      );
      expect(() => db.exec("UPDATE neo_ask_items SET state = 'invalid'")).toThrow();
      expect(() => db.exec("INSERT INTO child VALUES ('missing')")).toThrow();
    } finally {
      db.close();
    }
  });
  test('restores the original schema and settings if integrity validation fails', () => {
    const db = fixture();
    try {
      db.exec(
        "PRAGMA foreign_keys = OFF; INSERT INTO child VALUES ('missing'); PRAGMA foreign_keys = ON"
      );
      expect(() => runMigration359(db)).toThrow('neo_pack_check_registry_foreign_key_violation');
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(() => db.exec("UPDATE neo_ask_items SET check_kind = 'legal.confirmed'")).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM neo_ask_items').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
  test('does nothing when the table is absent', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runMigration359(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
