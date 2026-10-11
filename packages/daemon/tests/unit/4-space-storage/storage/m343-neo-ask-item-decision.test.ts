import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration343 } from '../../../../src/storage/schema/m343-neo-ask-item-decision';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration343', () => {
  test('adds a decision flag to ask items once, unset on existing rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Assign #6545?', 'needs_you', 1)`);
    runMigration343(db);
    runMigration343(db);
    expect(db.prepare('SELECT id, decision FROM neo_ask_items').all()).toEqual([
      { id: 'i1', decision: 0 },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration343(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
