import { describe, expect, test } from 'bun:test';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks';
import { runMigration316 } from '../../../../src/storage/schema/m316-neo-ask-evidence';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(({ name }) => name);

describe('runMigration316', () => {
  test('adds the evidence column once, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
    db.exec('CREATE TABLE neo_concerns (id TEXT PRIMARY KEY)');
    runMigration313(db);
    runMigration316(db);
    runMigration316(db);
    expect(columns(db).filter((name) => name === 'evidence')).toEqual(['evidence']);
    const bare = new Database(':memory:');
    runMigration316(bare);
    expect(columns(bare)).toEqual([]);
  });
});
