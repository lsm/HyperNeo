import { describe, expect, test } from 'bun:test';
import { NeoWorkCheckRepository } from '../../../../src/storage/repositories/neo-work-check-repository';
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
    const checks = new NeoWorkCheckRepository(db);
    expect(['w1', 'w2', 'w3'].map((id) => checks.get(id))).toEqual([
      { workId: 'w1', signature: 'sig-1', toldAt: 50, reminded: 'sig-1' },
      { workId: 'w2', signature: 'sig-2', toldAt: null, reminded: null },
      null,
    ]);
  });

  test('creates the table without work pull requests, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration320(db);
    expect(new NeoWorkCheckRepository(db).get('w1')).toBe(null);
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

describe('NeoWorkCheckRepository', () => {
  test('keeps the reminder signature until another reminder goes out', () => {
    const db = withWork();
    runMigration320(db);
    const checks = new NeoWorkCheckRepository(db);

    checks.markTold('w1', 'a', 10);
    expect(checks.get('w1')).toEqual({ workId: 'w1', signature: 'a', toldAt: 10, reminded: null });
    checks.markTold('w1', 'a', 20, true);
    expect(checks.get('w1')).toMatchObject({ toldAt: 20, reminded: 'a' });
    checks.markTold('w1', 'b', 30);
    expect(checks.get('w1')).toMatchObject({ signature: 'b', toldAt: 30, reminded: 'a' });
    checks.markTold('w1', 'b', 40, true);
    expect(checks.get('w1')).toMatchObject({ toldAt: 40, reminded: 'b' });
  });

  test('reads and writes nothing before the migration has run', () => {
    const checks = new NeoWorkCheckRepository(withWork());
    checks.markTold('w1', 'a', 10);
    expect(checks.get('w1')).toBe(null);
  });
});
