import { describe, expect, test } from 'bun:test';
import { runMigration315 } from '../../../../src/storage/schema/m315-neo-devices';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration315', () => {
  test('creates the device and Live Activity tables once', () => {
    const db = new Database(':memory:');
    runMigration315(db);
    runMigration315(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'neo_%' ORDER BY name"
        )
        .all()
    ).toEqual([{ name: 'neo_devices' }, { name: 'neo_live_activities' }]);
  });

  test('rejects an unknown push environment', () => {
    const db = new Database(':memory:');
    runMigration315(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO neo_devices VALUES ('d', 'aa', 'staging', 'dev.hyperneo.neo', NULL, '[]', 0)"
        )
        .run()
    ).toThrow();
  });
});
