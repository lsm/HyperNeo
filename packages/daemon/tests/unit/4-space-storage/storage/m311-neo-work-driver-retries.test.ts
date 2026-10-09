import { describe, expect, test } from 'bun:test';
import { runMigration311 } from '../../../../src/storage/schema/m311-neo-work-driver-retries';
import { Database } from '../../../../src/storage/sqlite-compat';

function columns(db: Database): string[] {
  return (
    db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as Array<{ name: string }>
  ).map((column) => column.name);
}

describe('runMigration311', () => {
  test('adds the retries column once with a zero default, and skips databases without driver targets', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY, target TEXT)');
    db.exec("INSERT INTO neo_work_driver_targets VALUES ('w1', '{}')");
    runMigration311(db);
    runMigration311(db);
    expect(columns(db)).toEqual(['work_id', 'target', 'retries']);
    expect(db.prepare('SELECT retries FROM neo_work_driver_targets').get()).toEqual({ retries: 0 });
    const bare = new Database(':memory:');
    runMigration311(bare);
    expect(columns(bare)).toEqual([]);
  });
});
