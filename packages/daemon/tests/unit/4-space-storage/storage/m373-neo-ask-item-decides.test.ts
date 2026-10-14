import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration373 } from '../../../../src/storage/schema/m373-neo-ask-item-decides';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration373', () => {
  test('adds a decides column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Pick a date', 'needs_you', 1)`);
    runMigration373(db);
    runMigration373(db);
    db.exec(`UPDATE neo_ask_items SET decides = 'release date' WHERE id = 'i1'`);
    expect(db.prepare('SELECT id, state, decides FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', decides: 'release date' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration373(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
