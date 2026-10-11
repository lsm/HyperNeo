import { describe, expect, test } from 'bun:test';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-ask-item-check-kind-life-admin';
import { runMigration341 } from '../../../../src/storage/schema/m341-neo-ask-item-reported';
import { Database } from '../../../../src/storage/sqlite-compat';

const states = (db: Database) =>
  db.prepare('SELECT id, state, check_kind AS "check" FROM neo_ask_items ORDER BY id').all();

const lifeAdminItems = (db: Database) => {
  db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
  db.exec(`CREATE TABLE neo_ask_items (
    ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'met', 'needs_you')),
    evidence TEXT,
    check_kind TEXT CHECK (check_kind IN ('coding.pr_merged')),
    met_by TEXT CHECK (met_by IN ('neo', 'daemon', 'human')),
    removed INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ask_id, id)
  )`);
  db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
    VALUES ('a1', 'i1', 0, 'Fix merged to dev', 'met', 'coding.pr_merged', 1),
           ('a1', 'i2', 1, 'The iMac is updated', 'pending', NULL, 1)`);
  runMigration337(db);
};

describe('runMigration341', () => {
  test('admits the reported state, keeping the rows and check kinds', () => {
    const db = new Database(':memory:');
    lifeAdminItems(db);
    runMigration341(db);
    db.exec("UPDATE neo_ask_items SET state = 'reported' WHERE id = 'i2'");
    expect(states(db)).toEqual([
      { id: 'i1', state: 'met', check: 'coding.pr_merged' },
      { id: 'i2', state: 'reported', check: null },
    ]);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
      VALUES ('a1', 'i3', 2, 'Parcel arrives', 'pending', 'life-admin.confirmed', 2)`);
    expect(states(db)).toHaveLength(3);
  });

  test('runs once and skips databases without items', () => {
    const db = new Database(':memory:');
    lifeAdminItems(db);
    runMigration341(db);
    runMigration341(db);
    expect(states(db)).toHaveLength(2);
    const bare = new Database(':memory:');
    runMigration341(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
