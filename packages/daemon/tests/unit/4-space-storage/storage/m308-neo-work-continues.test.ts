import { describe, expect, test } from 'bun:test';
import { NeoWorkContinueRepository } from '../../../../src/storage/repositories/neo-work-continue-repository';
import { runMigration308 } from '../../../../src/storage/schema/m308-neo-work-continues';
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

describe('NeoWorkContinueRepository', () => {
  test('counts continues and keeps the latest time and message', () => {
    const db = withWork();
    runMigration308(db);
    const continues = new NeoWorkContinueRepository(db);
    expect(continues.record('w1', 'Build chat', 10)).toEqual({
      workId: 'w1',
      count: 1,
      continuedAt: 10,
      lastMessage: 'Build chat',
    });
    expect(continues.record('w1', 'Build settings', 20)).toEqual({
      workId: 'w1',
      count: 2,
      continuedAt: 20,
      lastMessage: 'Build settings',
    });
    expect(continues.list(['w1', 'w2']).map((item) => item.workId)).toEqual(['w1']);
    expect(new NeoWorkContinueRepository(withWork()).record('w1', 'x', 1)).toBe(null);
  });
});
