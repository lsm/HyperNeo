import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration432 } from '../../../../../src/storage/schema/m432-neo-question-document.ts';

describe('Question document upgrade', () => {
  test('preserves the existing question and answer through repeat upgrades', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_questions(id TEXT PRIMARY KEY, text TEXT, answer TEXT);
        INSERT INTO neo_questions VALUES ('human', 'Original human question', 'yes')`);
      runMigration432(db);
      runMigration432(db);
      expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
        id: 'human',
        text: 'Original human question',
        answer: 'yes',
        document: null,
      });
    } finally {
      db.close();
    }
  });
});
