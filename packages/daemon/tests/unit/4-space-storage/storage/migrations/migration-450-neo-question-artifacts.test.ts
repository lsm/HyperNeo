import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration450 } from '../../../../../src/storage/schema/m450-neo-question-artifacts.ts';

describe('Question artifact references upgrade', () => {
  test('preserves home-conflict documents through repeat upgrades', () => {
    const db = new Database(':memory:');
    try {
      runMigration450(db);
      db.exec(`CREATE TABLE neo_questions(id TEXT PRIMARY KEY, document TEXT);
        INSERT INTO neo_questions VALUES ('question', 'Home conflict version')`);
      runMigration450(db);
      runMigration450(db);
      expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
        id: 'question',
        document: 'Home conflict version',
        artifacts_json: null,
      });
      expect(() => db.exec("UPDATE neo_questions SET artifacts_json = 'invalid json'")).toThrow();
    } finally {
      db.close();
    }
  });
});
