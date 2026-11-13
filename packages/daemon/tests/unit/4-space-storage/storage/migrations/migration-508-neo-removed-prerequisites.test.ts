import { describe, expect, test } from 'bun:test';
import { runMigration508 } from '../../../../../src/storage/schema/m508-neo-removed-prerequisites.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration508', () => {
  test('adds the cause column once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, text TEXT);
      INSERT INTO neo_questions VALUES ('q', 'ask', 'Start?');
    `);
    runMigration508(db);
    runMigration508(db);
    expect(db.prepare('SELECT id, text, cause FROM neo_questions').all()).toEqual([
      { id: 'q', text: 'Start?', cause: null },
    ]);
    db.close();
  });
});
