import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration348 } from '../../../../src/storage/schema/m348-neo-ask-item-action';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration348', () => {
  test('adds action and wait_card columns to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Pick a date', 'needs_you', 1)`);
    runMigration348(db);
    runMigration348(db);
    db.exec(`UPDATE neo_ask_items SET action = 'Answer in chat', wait_card = 'w1' WHERE id = 'i1'`);
    expect(db.prepare('SELECT id, state, action, wait_card FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', action: 'Answer in chat', wait_card: 'w1' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration348(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
