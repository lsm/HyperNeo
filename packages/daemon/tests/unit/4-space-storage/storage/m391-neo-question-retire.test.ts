import { describe, expect, test } from 'bun:test';
import { runMigration391 } from '../../../../src/storage/schema/m391-neo-question-retire.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const columns = (db: Database) =>
  (db.prepare('PRAGMA table_info(neo_questions)').all() as { name: string }[]).map(
    (column) => column.name
  );

describe('runMigration391', () => {
  test('adds the retire reason and replacement to an existing questions table, once', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE neo_questions (id TEXT PRIMARY KEY, state TEXT NOT NULL)`);
    db.prepare("INSERT INTO neo_questions (id, state) VALUES ('q', 'open')").run();
    runMigration391(db);
    runMigration391(db);
    expect(columns(db)).toEqual(['id', 'state', 'retired_reason', 'replaced_by']);
    expect(db.prepare('SELECT * FROM neo_questions').get()).toEqual({
      id: 'q',
      state: 'open',
      retired_reason: null,
      replaced_by: null,
    });
    db.close();
  });

  test('leaves a database without the questions table alone', () => {
    const db = new Database(':memory:');
    runMigration391(db);
    expect(columns(db)).toEqual([]);
    db.close();
  });
});
