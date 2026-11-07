import { describe, expect, test } from 'bun:test';
import { runMigration486 } from '../../../../../src/storage/schema/m486-neo-ask-topic.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('migration 486 neo ask topic', () => {
  test('adds a nullable topic column once and skips a database without asks', () => {
    const db = new Database(':memory:');
    runMigration486(db);
    db.exec("CREATE TABLE neo_asks (id TEXT PRIMARY KEY); INSERT INTO neo_asks VALUES ('a')");
    runMigration486(db);
    runMigration486(db);
    expect(db.prepare('SELECT id, topic FROM neo_asks').all()).toEqual([{ id: 'a', topic: null }]);
    db.close();
  });
});
