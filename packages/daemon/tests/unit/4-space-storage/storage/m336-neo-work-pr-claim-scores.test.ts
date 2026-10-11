import { describe, expect, test } from 'bun:test';
import { runMigration336 } from '../../../../src/storage/schema/m336-neo-work-pr-claim-scores';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration336', () => {
  test('adds an empty score to existing claims, once, and skips databases without them', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE neo_work_pr_claims (work_id TEXT, url_key TEXT, claim TEXT)');
    db.exec("INSERT INTO neo_work_pr_claims VALUES ('w1', 'u', 'mentioned')");
    runMigration336(db);
    runMigration336(db);
    expect(db.prepare('SELECT work_id AS id, score FROM neo_work_pr_claims').all()).toEqual([
      { id: 'w1', score: null },
    ]);
    const bare = new Database(':memory:');
    runMigration336(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });
});
