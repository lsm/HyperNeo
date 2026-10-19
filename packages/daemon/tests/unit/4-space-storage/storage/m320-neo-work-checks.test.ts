import { describe, expect, test } from 'bun:test';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders';
import { runMigration320 } from '../../../../src/storage/schema/m320-neo-work-checks';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1'), ('w2'), ('w3')");
  return db;
}

const workChecks = (db: Database) => ({
  get: (workId: string) =>
    db
      .prepare(
        'SELECT work_id AS workId, signature, told_at AS toldAt, reminded FROM neo_work_checks WHERE work_id = ?'
      )
      .get(workId) ?? null,
  markTold: (workId: string, signature: string, at: number, reminded = false) =>
    db
      .prepare(
        'INSERT INTO neo_work_checks(work_id, signature, told_at, reminded) VALUES (?, ?, ?, ?)'
      )
      .run(workId, signature, at, reminded ? signature : null),
});

describe('runMigration320', () => {
  test('copies what Neo was told from work pull requests, once', () => {
    const db = withWork();
    runMigration314(db);
    runMigration317(db);
    const insert = db.prepare(
      `INSERT INTO neo_work_prs(work_id, prs_json, open, revision, delivered, delivered_at, reminded, read_at, read_ok_at)
         VALUES (?, '[]', 1, 1, ?, ?, ?, 0, 0)`
    );
    insert.run('w1', 'sig-1', 50, 'sig-1');
    insert.run('w2', 'sig-2', null, null);
    insert.run('w3', null, null, null);
    runMigration320(db);
    runMigration320(db);
    const checks = workChecks(db);
    expect(['w1', 'w2', 'w3'].map((id) => checks.get(id))).toEqual([
      { workId: 'w1', signature: 'sig-1', toldAt: 50, reminded: 'sig-1' },
      { workId: 'w2', signature: 'sig-2', toldAt: null, reminded: null },
      null,
    ]);
  });

  test('creates the table without work pull requests, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration320(db);
    expect(workChecks(db).get('w1')).toBe(null);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_checks'").get()
    ).toEqual({ name: 'neo_work_checks' });
    const bare = new Database(':memory:');
    runMigration320(bare);
    expect(
      bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_checks'").get()
    ).toBe(null);
  });
});
