import { describe, expect, test } from 'bun:test';
import { runMigration327 } from '../../../../src/storage/schema/m327-neo-ask-approved-continues';
import { Database } from '../../../../src/storage/sqlite-compat';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).map(({ name }) => name);

describe('runMigration327', () => {
  test('adds the shared continue count once, starting at zero, and skips databases without asks', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_asks (id TEXT PRIMARY KEY)');
    db.exec("INSERT INTO neo_asks VALUES ('a1')");
    runMigration327(db);
    runMigration327(db);
    expect(columns(db)).toEqual(['id', 'approved_continues']);
    expect(db.prepare('SELECT approved_continues AS n FROM neo_asks').get()).toEqual({ n: 0 });
    const bare = new Database(':memory:');
    runMigration327(bare);
    expect(columns(bare)).toEqual([]);
  });
});
