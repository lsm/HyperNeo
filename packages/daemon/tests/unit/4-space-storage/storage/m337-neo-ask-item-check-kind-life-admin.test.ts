import { describe, expect, test } from 'bun:test';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-ask-item-check-kind-life-admin';
import { Database } from '../../../../src/storage/sqlite-compat';

const kinds = (db: Database) =>
  db.prepare('SELECT id, check_kind AS "check" FROM neo_ask_items ORDER BY id').all() as {
    id: string;
    check: string | null;
  }[];

const codingItems = (db: Database) => {
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
    VALUES ('a1', 'i1', 0, 'Fix merged to dev', 'pending', 'coding.pr_merged', 1),
           ('a1', 'i2', 1, 'Docs updated', 'pending', NULL, 1)`);
};

describe('runMigration337', () => {
  test('admits the life-admin kind beside coding.pr_merged, keeping the rows', () => {
    const db = new Database(':memory:');
    codingItems(db);
    runMigration337(db);
    expect(kinds(db)).toEqual([
      { id: 'i1', check: 'coding.pr_merged' },
      { id: 'i2', check: null },
    ]);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
      VALUES ('a1', 'i3', 2, 'Order confirmation from Amazon arrives', 'pending', 'life-admin.confirmed', 2)`);
    expect(kinds(db)).toEqual([
      { id: 'i1', check: 'coding.pr_merged' },
      { id: 'i2', check: null },
      { id: 'i3', check: 'life-admin.confirmed' },
    ]);
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_ask_items'").get()
    ).toMatchObject({ sql: expect.stringContaining("'life-admin.confirmed'") });
  });

  test('runs once and skips databases without items or already carrying the kind', () => {
    const db = new Database(':memory:');
    codingItems(db);
    runMigration337(db);
    runMigration337(db);
    expect(kinds(db)).toHaveLength(2);
    const bare = new Database(':memory:');
    runMigration337(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });

  test('runs after the m328 sequence on a legacy database', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    db.exec(`CREATE TABLE neo_ask_items (
      ask_id TEXT NOT NULL REFERENCES neo_asks(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'met', 'needs_you')),
      evidence TEXT,
      check_kind TEXT CHECK (check_kind IN ('pr_merged')),
      met_by TEXT CHECK (met_by IN ('neo', 'daemon', 'human')),
      removed INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (ask_id, id)
    )`);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
      VALUES ('a1', 'i1', 0, 'Fix merged to dev', 'pending', 'pr_merged', 1)`);
    runMigration328(db);
    runMigration337(db);
    expect(kinds(db)).toEqual([{ id: 'i1', check: 'coding.pr_merged' }]);
  });
});
