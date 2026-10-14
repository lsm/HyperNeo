import { describe, expect, test } from 'bun:test';
import { runMigration362 } from '../../../../src/storage/schema/m362-neo-driver-configuration.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('runMigration362', () => {
  test('preserves legacy rows, handles partial upgrades, and is repeatable', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY, actual_model TEXT)');
      db.exec("INSERT INTO neo_work_driver_targets VALUES ('w1', 'observed-model'), ('w2', NULL)");
      runMigration362(db);
      runMigration362(db);
      expect(db.prepare('SELECT * FROM neo_work_driver_targets ORDER BY work_id').all()).toEqual([
        { work_id: 'w1', actual_model: 'observed-model', actual_effort: null },
        { work_id: 'w2', actual_model: null, actual_effort: null },
      ]);
    } finally {
      db.close();
    }
  });

  test('leaves a database without driver targets unchanged', () => {
    const db = new Database(':memory:');
    try {
      runMigration362(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
