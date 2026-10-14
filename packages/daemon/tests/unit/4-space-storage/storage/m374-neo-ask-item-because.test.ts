import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration374 } from '../../../../src/storage/schema/m374-neo-ask-item-because';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration374', () => {
  test('adds a because column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Pick a date', 'needs_you', 1)`);
    runMigration374(db);
    runMigration374(db);
    db.exec(
      `UPDATE neo_ask_items SET because = '{"card":"c1","reason":"card_failed"}' WHERE id = 'i1'`
    );
    expect(db.prepare('SELECT id, state, because FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', because: '{"card":"c1","reason":"card_failed"}' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration374(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
