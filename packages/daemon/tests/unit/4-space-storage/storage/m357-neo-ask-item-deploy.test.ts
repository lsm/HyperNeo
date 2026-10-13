import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration357 } from '../../../../src/storage/schema/m357-neo-ask-item-deploy';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration357', () => {
  test('adds a deploy column to ask items once, keeping the rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Running on both daemons', 'pending', 1)`);
    runMigration357(db);
    runMigration357(db);
    db.exec(
      `UPDATE neo_ask_items SET deploy = '{"change":"https://github.com/o/r/pull/1"}' WHERE id = 'i1'`
    );
    expect(db.prepare('SELECT id, state, deploy FROM neo_ask_items').all()).toEqual([
      { id: 'i1', state: 'pending', deploy: '{"change":"https://github.com/o/r/pull/1"}' },
    ]);
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration357(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
