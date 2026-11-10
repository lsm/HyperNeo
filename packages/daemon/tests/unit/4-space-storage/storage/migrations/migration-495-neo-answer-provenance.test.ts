import { expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration495 } from '../../../../../src/storage/schema/m495-neo-answer-provenance.ts';

test('answer provenance upgrades existing cards idempotently', () => {
  const db = new Database(':memory:');
  try {
    runMigration495(db);
    db.exec(
      "CREATE TABLE neo_questions(id TEXT PRIMARY KEY, answer TEXT); INSERT INTO neo_questions VALUES ('old', '\"Existing words\"')"
    );
    runMigration495(db);
    expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
      id: 'old',
      answer: '"Existing words"',
      answer_provenance_json: null,
    });
    const provenance = JSON.stringify({
      via: 'sender',
      viaName: 'Relay',
      where: 'here',
      when: 'earlier',
      at: 1,
    });
    db.prepare('UPDATE neo_questions SET answer_provenance_json = ?').run(provenance);
    runMigration495(db);
    expect(db.prepare('SELECT answer_provenance_json FROM neo_questions').get()).toEqual({
      answer_provenance_json: provenance,
    });
    expect(() => db.exec("UPDATE neo_questions SET answer_provenance_json = 'invalid'")).toThrow();
  } finally {
    db.close();
  }
});
