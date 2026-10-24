import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration452 } from '../../../../../src/storage/schema/m452-neo-question-source.ts';

describe('Question source-session upgrade', () => {
  test('preserves existing questions and source refs through repeated upgrades', () => {
    const db = new Database(':memory:');
    try {
      runMigration452(db);
      db.exec(
        "CREATE TABLE neo_questions(id TEXT PRIMARY KEY, text TEXT); INSERT INTO neo_questions VALUES ('q', 'Existing question')"
      );
      runMigration452(db);
      expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
        id: 'q',
        text: 'Existing question',
        source_session_json: null,
      });
      const source = JSON.stringify({
        adapter: 'codex-desktop',
        id: 'worker',
        name: 'Review',
        provider: 'Codex',
        label: 'Codex · Review',
        link: 'codex://threads/worker',
      });
      db.prepare('UPDATE neo_questions SET source_session_json = ?').run(source);
      runMigration452(db);
      expect(db.prepare('SELECT source_session_json FROM neo_questions').get()).toEqual({
        source_session_json: source,
      });
      expect(() =>
        db.exec("UPDATE neo_questions SET source_session_json = 'invalid json'")
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
