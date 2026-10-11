import { describe, expect, test } from 'bun:test';
import { NeoWorkPrRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders';
import { runMigration320 } from '../../../../src/storage/schema/m320-neo-work-checks';
import { runMigration323 } from '../../../../src/storage/schema/m323-neo-work-check-evidence';
import { runMigration332 } from '../../../../src/storage/schema/m332-neo-work-supersessions';
import { runMigration333 } from '../../../../src/storage/schema/m333-neo-work-pr-claims';
import { runMigration334 } from '../../../../src/storage/schema/m334-neo-driver-start-interrupted';
import { runMigration335 } from '../../../../src/storage/schema/m335-neo-work-prs-drop-delivered';
import { Database } from '../../../../src/storage/sqlite-compat';

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1')");
  return db;
}

function columnsOf(db: Database): string[] {
  return (db.prepare('PRAGMA table_info(neo_work_prs)').all() as { name: string }[]).map(
    (column) => column.name
  );
}

describe('runMigration335', () => {
  test('drops the copied delivery columns once, keeping the rest of the row', () => {
    const db = withWork();
    runMigration314(db);
    runMigration317(db);
    runMigration320(db);
    db.exec(
      `INSERT INTO neo_work_prs(work_id, prs_json, open, revision, delivered, delivered_at, reminded, read_at, read_ok_at)
         VALUES ('w1', '[]', 1, 3, 'sig', 25, 'sig', 20, 30)`
    );
    runMigration335(db);
    runMigration335(db);
    expect(columnsOf(db)).toEqual([
      'work_id',
      'prs_json',
      'open',
      'revision',
      'read_at',
      'read_ok_at',
    ]);
    expect(new NeoWorkPrRepository(db).get('w1')).toMatchObject({ revision: 3, readOkAt: 30 });
  });

  test('leaves a table that never had the columns, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration314(db);
    runMigration335(db);
    expect(columnsOf(db)).toContain('read_at');
    const bare = new Database(':memory:');
    runMigration333(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_prs'").get()).toBe(
      null
    );
  });

  test('runs after the full sequence from a fresh migration walk', () => {
    const db = withWork();
    runMigration314(db);
    runMigration317(db);
    runMigration320(db);
    runMigration323(db);
    runMigration332(db);
    runMigration333(db);
    runMigration334(db);
    runMigration335(db);
    const prs = new NeoWorkPrRepository(db);
    expect(prs.record('w1', [], 10)).toMatchObject({ revision: 1, readAt: 10 });
    expect(() => db.prepare('SELECT delivered FROM neo_work_prs').all()).toThrow();
  });
});
