import { describe, expect, test } from 'bun:test';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-driver-checked-at';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration337', () => {
  test('adds the card check columns once, and skips databases without driver targets', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO neo_work_driver_targets VALUES ('w1')");
    runMigration337(db);
    runMigration337(db);
    expect(
      db
        .prepare(
          'SELECT work_id AS id, checked_at AS checkedAt, unchecked FROM neo_work_driver_targets'
        )
        .all()
    ).toEqual([{ id: 'w1', checkedAt: null, unchecked: 0 }]);
    const bare = new Database(':memory:');
    runMigration337(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
