import { describe, expect, test } from 'bun:test';
import { runMigration324 } from '../../../../src/storage/schema/m324-neo-ask-pack';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(({ name }) => name);

describe('runMigration324', () => {
  test('adds the pack column once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration324(db);
    runMigration324(db);
    expect(columns(db)).toEqual(['id', 'pack']);
    const bare = new Database(':memory:');
    runMigration324(bare);
    expect(columns(bare)).toEqual([]);
  });
});
