import { describe, expect, test } from 'bun:test';
import { runMigration515 } from '../../../../../src/storage/schema/m515-neo-question-held.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration515', () => {
  test('adds the hold columns once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, text TEXT);
      INSERT INTO neo_questions VALUES ('q', 'ask', 'Ship it?');
    `);
    runMigration515(db);
    runMigration515(db);
    expect(db.prepare('SELECT id, text, held_at, hold_requests FROM neo_questions').all()).toEqual([
      { id: 'q', text: 'Ship it?', held_at: null, hold_requests: null },
    ]);
    db.close();
  });
});
