import { describe, expect, test } from 'bun:test';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_work_prs)').all() as { name: string }[]).map(
    ({ name }) => name
  );

describe('runMigration317', () => {
  test('adds the reminder columns once, and skips databases without work pull requests', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
    runMigration314(db);
    runMigration317(db);
    runMigration317(db);
    expect(columns(db).filter((name) => ['delivered_at', 'reminded'].includes(name))).toEqual([
      'delivered_at',
      'reminded',
    ]);
    const bare = new Database(':memory:');
    runMigration317(bare);
    expect(columns(bare)).toEqual([]);
  });
});
