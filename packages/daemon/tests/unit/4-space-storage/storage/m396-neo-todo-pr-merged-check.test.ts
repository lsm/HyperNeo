import { describe, expect, test } from 'bun:test';
import { runMigration396 } from '../../../../src/storage/schema/m396-neo-todo-pr-merged-check.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('runMigration396', () => {
  test('rewrites stored coding pr_opened checks to pr_merged and leaves other checks alone', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_todos (id TEXT PRIMARY KEY, check_json TEXT)');
    const insert = db.prepare('INSERT INTO neo_todos (id, check_json) VALUES (?, ?)');
    insert.run('opened', '{"pack":"coding","kind":"pr_opened","params":{"urls":["u"]}}');
    insert.run('merged', '{"pack":"coding","kind":"pr_merged","params":{}}');
    insert.run('other', '{"pack":"life-admin","kind":"pr_opened","params":{}}');
    insert.run('none', null);
    runMigration396(db);
    runMigration396(db);
    const rows = db.prepare('SELECT id, check_json AS json FROM neo_todos ORDER BY id').all() as {
      id: string;
      json: string | null;
    }[];
    expect(rows.map((row) => [row.id, row.json ? JSON.parse(row.json) : null])).toEqual([
      ['merged', { pack: 'coding', kind: 'pr_merged', params: {} }],
      ['none', null],
      ['opened', { pack: 'coding', kind: 'pr_merged', params: { urls: ['u'] } }],
      ['other', { pack: 'life-admin', kind: 'pr_opened', params: {} }],
    ]);
    db.close();
  });

  test('leaves a database without the todos table alone', () => {
    const db = new Database(':memory:');
    runMigration396(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_todos'").get()).toBeNull();
    db.close();
  });
});
