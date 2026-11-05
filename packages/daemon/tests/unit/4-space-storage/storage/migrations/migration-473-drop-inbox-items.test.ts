import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration473 } from '../../../../../src/storage/schema/m473-drop-inbox-items.ts';

const tableExists = (db: Database) =>
  !!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'inbox_items'`).get();

describe('migration 473: drop inbox_items', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE inbox_items (id TEXT PRIMARY KEY);
      CREATE INDEX idx_inbox_items_status ON inbox_items(id);`);
  });

  afterEach(() => {
    db.close();
  });

  test('drops the empty table and its indexes', () => {
    runMigration473(db);

    expect(tableExists(db)).toBe(false);
    expect(
      db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'idx_inbox_items_status'`).get()
    ).toBeNull();
  });

  test('keeps a table that still has rows', () => {
    db.exec(`INSERT INTO inbox_items (id) VALUES ('kept')`);

    runMigration473(db);

    expect(db.prepare('SELECT id FROM inbox_items').all()).toEqual([{ id: 'kept' }]);
  });

  test('does nothing when the table is already gone', () => {
    db.exec('DROP TABLE inbox_items');

    runMigration473(db);

    expect(tableExists(db)).toBe(false);
  });
});
