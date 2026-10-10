import { describe, expect, test } from 'bun:test';
import { runMigration326 } from '../../../../src/storage/schema/m326-neo-ask-approved';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(({ name }) => name);

describe('runMigration326', () => {
  test('adds the approval column once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    runMigration326(db);
    runMigration326(db);
    expect(columns(db)).toEqual(['id', 'approved_at']);
    const bare = new Database(':memory:');
    runMigration326(bare);
    expect(columns(bare)).toEqual([]);
  });
});
