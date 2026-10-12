import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration352 } from '../../../../src/storage/schema/m352-neo-ask-item-watch';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration352', () => {
  test('adds a watch column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Pick a date', 'needs_you', 1)`);
    runMigration352(db);
    runMigration352(db);
    db.exec(`UPDATE neo_ask_items SET watch = '["https://github.com/o/r/pull/1"]' WHERE id = 'i1'`);
    expect(db.prepare('SELECT id, state, watch FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'needs_you', watch: '["https://github.com/o/r/pull/1"]' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration352(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
