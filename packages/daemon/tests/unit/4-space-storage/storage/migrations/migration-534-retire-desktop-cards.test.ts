import { describe, expect, test } from 'vitest';
import { runMigrations } from '../../../../../src/storage/schema/migrations.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigrations', () => {
  test('retires open desktop control cards, keeps answered ones and grants nothing', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, () => {});
      db.exec('PRAGMA foreign_keys = OFF');
      const insert = db.prepare(
        `INSERT INTO neo_questions (id, ask_id, text, kind, state, answer, desktop_app, created_at)
         VALUES (?, 'ask', 'Allow desktop control?', 'choice', ?, ?, ?, 1)`
      );
      insert.run('open-card', 'open', null, 'Calendar');
      insert.run('answered-card', 'answered', '"Allow"', 'Calendar');
      insert.run('plain', 'open', null, null);
      db.exec("DELETE FROM migration_markers WHERE key = 'migration_534'");
      runMigrations(db, () => {});
      const state = (id: string) =>
        db
          .prepare('SELECT state, retired_reason AS reason FROM neo_questions WHERE id = ?')
          .get(id);
      expect(state('open-card')).toEqual({
        state: 'retired',
        reason: expect.stringMatching(/^desktop_card_removed/),
      });
      expect(state('answered-card')).toEqual({ state: 'answered', reason: null });
      expect(state('plain')).toEqual({ state: 'open', reason: null });
      expect(
        db.prepare("SELECT 1 FROM neo_pack_preferences WHERE key = 'desktopControl'").get()
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});
