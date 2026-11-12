import { describe, expect, test } from 'bun:test';
import { runMigration506 } from '../../../../../src/storage/schema/m506-neo-todo-stored-prerequisites.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const edges = (db: Database) =>
  Object.fromEntries(
    (
      db.prepare('SELECT id, depends_on AS dependsOn FROM neo_todos').all() as {
        id: string;
        dependsOn: string | null;
      }[]
    ).map((row) => [row.id, row.dependsOn && JSON.parse(row.dependsOn)])
  );

describe('runMigration506', () => {
  test('stores the wait an open row has today and leaves the rest alone, once', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, ask_id TEXT, position INTEGER, state TEXT,
        depends_on TEXT);
      INSERT INTO neo_asks VALUES ('ask', 'open'), ('settled', 'done');
      INSERT INTO neo_todos VALUES
        ('first', 'ask', 0, 'done', NULL),
        ('second', 'ask', 1, 'todo', NULL),
        ('named', 'ask', 2, 'blocked', '[]'),
        ('third', 'ask', 3, 'doing', NULL),
        ('gone', 'ask', 4, 'removed', NULL),
        ('lone', 'settled', 0, 'failed', NULL),
        ('after', 'settled', 1, 'todo', NULL);
    `);
    runMigration506(db);
    runMigration506(db);
    expect(edges(db)).toEqual({
      first: null,
      second: ['first'],
      named: [],
      third: ['named'],
      gone: null,
      lone: null,
      after: null,
    });
    db.close();
  });
});
