import { expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration442 } from '../../../../../src/storage/schema/m442-neo-question-reply-to.ts';

test('reply references upgrade preserves existing questions and answers on repeated startup', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE neo_questions(id TEXT PRIMARY KEY, text TEXT, answer TEXT);
      INSERT INTO neo_questions VALUES ('human', 'Original human question', 'yes')`);
    runMigration442(db);
    runMigration442(db);
    expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
      id: 'human',
      text: 'Original human question',
      answer: 'yes',
      reply_to_json: null,
    });
  } finally {
    db.close();
  }
});
