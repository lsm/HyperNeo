import { describe, expect, test } from 'bun:test';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration326 } from '../../../../src/storage/schema/m326-neo-ask-item-check-kinds';
import { Database } from '../../../../src/storage/sqlite-compat';

const legacy = (db: Database) => {
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
    VALUES ('a1', 'i1', 0, 'Fix merged to dev', 'pending', 'pr_merged', 1),
           ('a1', 'i2', 1, 'Docs updated', 'pending', NULL, 1)`);
};

const kinds = (db: Database) =>
  db.prepare('SELECT id, check_kind AS "check" FROM neo_ask_items ORDER BY id').all() as {
    id: string;
    check: string | null;
  }[];

describe('runMigration326', () => {
  test('renames the check kind on existing rows and keeps the items', () => {
    const db = new Database(':memory:');
    legacy(db);
    runMigration326(db);
    expect(kinds(db)).toEqual([
      { id: 'i1', check: 'coding.pr_merged' },
      { id: 'i2', check: null },
    ]);
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_ask_items'").get()
    ).toMatchObject({ sql: expect.stringContaining("'coding.pr_merged'") });
  });

  test('runs once, rebuilds a fresh m318 database, and skips databases without items', () => {
    const db = new Database(':memory:');
    legacy(db);
    runMigration326(db);
    runMigration326(db);
    expect(kinds(db)).toEqual([
      { id: 'i1', check: 'coding.pr_merged' },
      { id: 'i2', check: null },
    ]);
    const fresh = new Database(':memory:');
    fresh.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    runMigration313(fresh);
    runMigration318(fresh);
    runMigration326(fresh);
    expect(
      fresh.prepare("SELECT sql FROM sqlite_master WHERE name = 'neo_ask_items'").get()
    ).toMatchObject({ sql: expect.stringContaining("'coding.pr_merged'") });
    const bare = new Database(':memory:');
    runMigration326(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
