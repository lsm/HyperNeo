import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration342 } from '../../../../src/storage/schema/m342-neo-ask-item-options';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration342', () => {
  test('adds an options column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Assign #6545?', 'needs_you', 1)`);
    runMigration342(db);
    runMigration342(db);
    db.exec(`UPDATE neo_ask_items SET options = '["Yes","No"]' WHERE id = 'i1'`);
    expect(db.prepare('SELECT id, state, options FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', options: '["Yes","No"]' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration342(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
