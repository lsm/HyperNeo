import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration351 } from '../../../../src/storage/schema/m351-neo-ask-item-question';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration351', () => {
  test('adds a question column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Keyboard hides on send', 'needs_you', 1)`);
    runMigration351(db);
    runMigration351(db);
    db.exec(`UPDATE neo_ask_items SET question = 'Did the keyboard hide?' WHERE id = 'i1'`);
    expect(db.prepare('SELECT id, state, question FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', question: 'Did the keyboard hide?' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration351(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
