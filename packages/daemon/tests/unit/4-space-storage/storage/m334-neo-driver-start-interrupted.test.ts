import { describe, expect, test } from 'bun:test';
import { runMigration334 } from '../../../../src/storage/schema/m334-neo-driver-start-interrupted';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration334', () => {
  test('flags driver cards whose start was interrupted, once, and skips databases without them', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY, report TEXT)');
    db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY)');
    db.exec(`INSERT INTO neo_work VALUES
      ('w1', 'Starting was interrupted before codex-desktop confirmed it. It may still have started.'),
      ('w2', 'It stopped.'), ('w3', NULL)`);
    db.exec("INSERT INTO neo_work_driver_targets VALUES ('w1'), ('w2'), ('w3')");
    runMigration334(db);
    runMigration334(db);
    expect(
      db
        .prepare(
          'SELECT work_id AS id, start_interrupted AS interrupted FROM neo_work_driver_targets ORDER BY work_id'
        )
        .all()
    ).toEqual([
      { id: 'w1', interrupted: 1 },
      { id: 'w2', interrupted: 0 },
      { id: 'w3', interrupted: 0 },
    ]);
    const bare = new Database(':memory:');
    runMigration334(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
