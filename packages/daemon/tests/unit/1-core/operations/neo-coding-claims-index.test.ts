import { describe, expect, test } from 'bun:test';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { runMigration447 } from '../../../../src/storage/schema/m447-neo-todo-removed-index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const url = 'https://github.com/synthetic/claims/pull/7';

describe('coding claims removed-todo index upgrade', () => {
  test('keeps claims, removal visibility and NULL exclusion unchanged across upgrade', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE neo_todos(id TEXT PRIMARY KEY, state TEXT NOT NULL, report TEXT)');
      createCodingPackTables(db);
      const put = db.prepare('INSERT INTO neo_todos VALUES(?,?,?)');
      put.run('live', 'doing', 'Complete live report');
      put.run('removed', 'removed', 'Complete removed report');
      db.prepare('INSERT INTO pack_coding_pr_claims VALUES(?,?,?,?),(?,?,?,?)').run(
        'live',
        url,
        'branch',
        1,
        'removed',
        url,
        'named',
        2
      );
      const repo = new CodingTodoPrRepository(db);
      const before = repo.claimsOn([url]);
      const stored = () => ({
        todos: db.prepare('SELECT * FROM neo_todos ORDER BY id').all(),
        claims: db.prepare('SELECT * FROM pack_coding_pr_claims ORDER BY todo_id').all(),
      });
      const original = stored();
      expect(before).toEqual([{ todoId: 'live', url, claim: 'branch', claimedAt: 1 }]);
      runMigration447(db);
      runMigration447(db);
      expect(stored()).toEqual(original);
      expect(repo.claimsOn([url])).toEqual(before);
      expect(repo.claimsOn([])).toEqual([]);
      db.prepare("UPDATE neo_todos SET state='done' WHERE id='removed'").run();
      expect(repo.claimsOn([url])).toHaveLength(2);
      put.run(null, 'removed', 'NULL-key historical row');
      expect(repo.claimsOn([url])).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM pack_coding_pr_claims').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  test('does not fail an older partial schema without todos', () => {
    const db = new Database(':memory:');
    try {
      expect(() => runMigration447(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
