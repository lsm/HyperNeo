import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration427 } from '../../../../../src/storage/schema/m427-neo-question-confirm.ts';

describe('Neo question confirmation upgrade', () => {
  test('adds a nullable binding once while preserving the legacy answer/body', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE neo_questions(id TEXT PRIMARY KEY, text TEXT, state TEXT, answer TEXT); INSERT INTO neo_questions VALUES ('legacy', 'Keep the original text', 'answered', '\"yes\"')"
      );
      runMigration427(db);
      runMigration427(db);
      expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
        id: 'legacy',
        text: 'Keep the original text',
        state: 'answered',
        answer: '"yes"',
        confirm_json: null,
      });
      expect(
        (db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[]).filter(
          (column) => column.name === 'confirm_json'
        )
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
