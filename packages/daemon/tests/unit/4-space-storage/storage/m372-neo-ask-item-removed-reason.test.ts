import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration372 } from '../../../../src/storage/schema/m372-neo-ask-item-removed-reason';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration372', () => {
  test('adds a removed reason column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Pick a date', 'needs_you', 1)`);
    runMigration372(db);
    runMigration372(db);
    db.exec(
      `UPDATE neo_ask_items SET removed = 1, removed_reason = 'The human said: "drop it"' WHERE id = 'i1'`
    );
    expect(
      db.prepare('SELECT id, state, removed_reason AS reason FROM neo_ask_items').all()
    ).toEqual([{ id: 'i1', state: 'needs_you', reason: 'The human said: "drop it"' }]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration372(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
