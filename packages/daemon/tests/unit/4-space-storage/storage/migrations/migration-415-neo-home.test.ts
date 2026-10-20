import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat';
import { runMigration415 } from '../../../../../src/storage/schema/m415-neo-home-path';

describe('Neo home path upgrade', () => {
  test('preserves an existing project and adds a nullable home path once', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE neo_concerns(id TEXT PRIMARY KEY, title TEXT, context TEXT, revision INTEGER); INSERT INTO neo_concerns VALUES ('project-release', 'Release', 'Human context', 7)"
      );
      runMigration415(db);
      runMigration415(db);
      expect(db.prepare('SELECT * FROM neo_concerns').get()).toEqual({
        id: 'project-release',
        title: 'Release',
        context: 'Human context',
        revision: 7,
        home_path: null,
      });
      expect(
        (db.prepare('PRAGMA table_info(neo_concerns)').all() as { name: string }[]).filter(
          (column) => column.name === 'home_path'
        )
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
