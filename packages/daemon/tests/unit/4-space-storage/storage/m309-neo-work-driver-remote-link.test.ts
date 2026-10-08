import { describe, expect, test } from 'bun:test';
import { runMigration309 } from '../../../../src/storage/schema/m309-neo-work-driver-remote-link';
import { Database } from '../../../../src/storage/sqlite-compat';

function columns(db: Database): string[] {
  return (
    db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as Array<{ name: string }>
  ).map((column) => column.name);
}

describe('runMigration309', () => {
  test('adds the remote link column once, and skips databases without driver targets', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY, target TEXT)');
    runMigration309(db);
    runMigration309(db);
    expect(columns(db)).toEqual(['work_id', 'target', 'remote_link']);
    const bare = new Database(':memory:');
    runMigration309(bare);
    expect(columns(bare)).toEqual([]);
  });
});
