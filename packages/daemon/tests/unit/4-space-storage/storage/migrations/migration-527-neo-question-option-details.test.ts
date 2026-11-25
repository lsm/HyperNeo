import { describe, expect, test } from 'bun:test';
import { runMigration527 } from '../../../../../src/storage/schema/m527-neo-question-option-details.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

describe('runMigration527', () => {
  test('adds the option detail columns once and leaves existing rows alone', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, text TEXT);
      INSERT INTO neo_questions VALUES ('q', 'Which hotel?');
    `);
    runMigration527(db);
    runMigration527(db);
    expect(
      db.prepare('SELECT id, text, option_details_json, recommended FROM neo_questions').all()
    ).toEqual([{ id: 'q', text: 'Which hotel?', option_details_json: null, recommended: null }]);
    db.prepare('UPDATE neo_questions SET option_details_json=? WHERE id=?').run('{"a":"b"}', 'q');
    expect(() =>
      db.prepare('UPDATE neo_questions SET option_details_json=? WHERE id=?').run('{', 'q')
    ).toThrow();
    expect(() =>
      db
        .prepare('INSERT INTO neo_questions (id, option_details_json) VALUES (?, ?)')
        .run('bad', '{')
    ).toThrow();
    db.close();
  });

  test('skips a database without the table', () => {
    const db = new Database(':memory:');
    runMigration527(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_questions'").all()).toEqual(
      []
    );
    db.close();
  });
});
