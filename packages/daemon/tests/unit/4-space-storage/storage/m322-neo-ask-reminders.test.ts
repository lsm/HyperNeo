import { describe, expect, test } from 'bun:test';
import { runMigration322 } from '../../../../src/storage/schema/m322-neo-ask-reminders';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(({ name }) => name);

describe('runMigration322', () => {
  test('adds the reminder column once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration322(db);
    runMigration322(db);
    expect(columns(db)).toEqual(['id', 'reminded_at']);
    const bare = new Database(':memory:');
    runMigration322(bare);
    expect(columns(bare)).toEqual([]);
  });
});
