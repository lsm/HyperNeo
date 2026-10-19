import { describe, expect, test } from 'bun:test';
import { runMigration307 } from '../../../../src/storage/schema/m307-neo-work-goals';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1'), ('w2')");
  return db;
}

describe('runMigration307', () => {
  test('creates the goals table once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration307(db);
    runMigration307(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_goals'").get()
    ).toEqual({ name: 'neo_work_goals' });

    const bare = new Database(':memory:');
    runMigration307(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_goals'").get()).toBe(
      null
    );
  });
});
