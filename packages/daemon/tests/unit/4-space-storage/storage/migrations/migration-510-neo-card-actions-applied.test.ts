import { describe, expect, test } from 'bun:test';
import { runMigration510 } from '../../../../../src/storage/schema/m510-neo-card-actions-applied.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration510', () => {
  test('adds the actions_applied_at column once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, text TEXT);
      INSERT INTO neo_questions VALUES ('q', 'ask', 'Retry?');
    `);
    runMigration510(db);
    runMigration510(db);
    expect(db.prepare('SELECT id, text, actions_applied_at FROM neo_questions').all()).toEqual([
      { id: 'q', text: 'Retry?', actions_applied_at: null },
    ]);
    db.close();
  });
});
