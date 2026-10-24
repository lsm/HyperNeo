import { expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration453 } from '../../../../../src/storage/schema/m453-neo-ask-focused-session.ts';

test('adds nullable focused metadata without altering old asks and can run twice', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      "CREATE TABLE neo_asks(id TEXT PRIMARY KEY, request TEXT); INSERT INTO neo_asks VALUES ('old', 'Keep this request')"
    );
    runMigration453(db);
    runMigration453(db);
    expect(db.prepare('SELECT * FROM neo_asks').get()).toEqual({
      id: 'old',
      request: 'Keep this request',
      focused_session_json: null,
    });
    expect(() =>
      db.prepare('UPDATE neo_asks SET focused_session_json = ?').run('not JSON')
    ).toThrow();
    const source = { adapter: 'hyperneo', id: 'discussion' };
    db.prepare('UPDATE neo_asks SET focused_session_json = ?').run(JSON.stringify(source));
    expect(db.prepare('SELECT focused_session_json FROM neo_asks').get()).toEqual({
      focused_session_json: JSON.stringify(source),
    });
  } finally {
    db.close();
  }
});
