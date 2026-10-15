import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration376 } from '../../../../src/storage/schema/m376-neo-ask-item-outcome-kind';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration376', () => {
  test('adds an outcome kind that defaults existing items to state, once', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration318(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, updated_at)
      VALUES ('a1', 'i1', 0, 'Merged', 'pending', 1)`);
    runMigration376(db);
    runMigration376(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, outcome_kind, updated_at)
      VALUES ('a1', 'i2', 1, 'How many files', 'pending', 'answer', 1)`);
    expect(db.prepare('SELECT id, outcome_kind AS kind FROM neo_ask_items').all()).toEqual([
      { id: 'i1', kind: 'state' },
      { id: 'i2', kind: 'answer' },
    ]);
    expect(() =>
      db.exec(`UPDATE neo_ask_items SET outcome_kind = 'maybe' WHERE id = 'i1'`)
    ).toThrow();
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration376(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
