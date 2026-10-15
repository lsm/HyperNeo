import { describe, expect, test } from 'bun:test';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-ask-item-check-kind-life-admin';
import { runMigration341 } from '../../../../src/storage/schema/m341-neo-ask-item-reported';
import { runMigration342 } from '../../../../src/storage/schema/m342-neo-ask-item-options';
import { runMigration343 } from '../../../../src/storage/schema/m343-neo-ask-item-decision';
import { runMigration346 } from '../../../../src/storage/schema/m346-neo-ask-item-issue-checks';
import { runMigration352 } from '../../../../src/storage/schema/m352-neo-ask-item-watch';
import { runMigration357 } from '../../../../src/storage/schema/m357-neo-ask-item-deploy-check';
import { runMigration378 } from '../../../../src/storage/schema/m378-neo-ask-item-pr-opened-check';
import { Database } from '../../../../src/storage/sqlite-compat';

const items = (db: Database) =>
  db.prepare('SELECT id, check_kind AS "check", watch FROM neo_ask_items ORDER BY id').all();

describe('runMigration378', () => {
  test('admits the pr_opened check kind and keeps every row and column', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    for (const migrate of [
      runMigration318,
      runMigration328,
      runMigration337,
      runMigration341,
      runMigration342,
      runMigration343,
      runMigration346,
      runMigration352,
      runMigration357,
    ])
      migrate(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, watch,
      updated_at) VALUES ('a1', 'i1', 0, 'Issue closed', 'pending', 'coding.issue_closed',
      '["https://github.com/o/r/issues/1"]', 1)`);
    runMigration378(db);
    runMigration378(db);
    db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind, updated_at)
      VALUES ('a1', 'i2', 1, 'PR open', 'pending', 'coding.pr_opened', 2)`);
    expect(items(db)).toEqual([
      { id: 'i1', check: 'coding.issue_closed', watch: '["https://github.com/o/r/issues/1"]' },
      { id: 'i2', check: 'coding.pr_opened', watch: null },
    ]);
    expect(() =>
      db.exec(`INSERT INTO neo_ask_items (ask_id, id, position, text, state, check_kind,
        updated_at) VALUES ('a1', 'i3', 2, 'x', 'pending', 'coding.nope', 3)`)
    ).toThrow();
  });

  test('skips a database without ask items', () => {
    const bare = new Database(':memory:');
    runMigration378(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_ask_items'").get()).toBe(
      null
    );
  });
});
