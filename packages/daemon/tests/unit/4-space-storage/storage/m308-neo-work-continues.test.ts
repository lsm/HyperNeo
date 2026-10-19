import { describe, expect, test } from 'bun:test';
import { runMigration308 } from '../../../../src/storage/schema/m308-neo-work-continues';
import { runMigration345 } from '../../../../src/storage/schema/m345-neo-work-continue-progress';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1'), ('w2')");
  return db;
}

describe('runMigration308', () => {
  test('creates the continues table once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration308(db);
    runMigration308(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_continues'").get()
    ).toEqual({ name: 'neo_work_continues' });
    const bare = new Database(':memory:');
    runMigration308(bare);
    expect(
      bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_continues'").get()
    ).toBe(null);
  });
});
