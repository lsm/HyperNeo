import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-ask-item-check-kind-life-admin';
import { runMigration341 } from '../../../../src/storage/schema/m341-neo-ask-item-reported';
import { runMigration342 } from '../../../../src/storage/schema/m342-neo-ask-item-options';
import { runMigration343 } from '../../../../src/storage/schema/m343-neo-ask-item-decision';
import { runMigration346 } from '../../../../src/storage/schema/m346-neo-ask-item-issue-checks';
import { Database } from '../../../../src/storage/sqlite-compat';

const items = (db: Database) =>
  db.prepare('SELECT id, state, check_kind AS "check", options, decision FROM neo_ask_items').all();

describe('runMigration346', () => {
  test('admits the issue check kinds and keeps every row and column', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    for (const migrate of [
      runMigration318,
      runMigration328,
      runMigration337,
      runMigration341,
      runMigration342,
      runMigration343,
    ])
      migrate(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, options,
      decision, updated_at) VALUES ('a1', 'i1', 0, 'Pick one', 'needs_you', NULL, '["A","B"]', 1, 1)`);
    runMigration346(db);
    runMigration346(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
      VALUES ('a1', 'i2', 1, 'Issue filed', 'pending', 'coding.issue_filed', 2)`);
    expect(items(db)).toEqual([
      { id: 'i1', state: 'needs_you', check: null, options: '["A","B"]', decision: 1 },
      { id: 'i2', state: 'pending', check: 'coding.issue_filed', options: null, decision: 0 },
    ]);
    expect(() =>
      db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind,
        updated_at) VALUES ('a1', 'i3', 2, 'x', 'pending', 'coding.nope', 3)`)
    ).toThrow();
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration346(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
