import { describe, expect, test } from 'bun:test';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { NeoWorkPrRepository } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders';
import { Database } from '../../../../src/storage/sqlite-compat';

const pr: NeoWorkPr = {
  url: 'https://github.com/lsm/HyperNeo/pull/42',
  state: 'OPEN',
  checks: 'pending',
  review: 'none',
};

function withWork() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE neo_work (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO neo_work VALUES ('w1')");
  return db;
}

describe('runMigration314', () => {
  test('creates the table once, and skips databases without Neo work', () => {
    const db = withWork();
    runMigration314(db);
    runMigration314(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_prs'").get()).toEqual({
      name: 'neo_work_prs',
    });
    const bare = new Database(':memory:');
    runMigration314(bare);
    expect(bare.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work_prs'").get()).toBe(
      null
    );
  });
});

describe('NeoWorkPrRepository', () => {
  test('bumps the revision only when the state changes, and stops listing merged work', () => {
    const db = withWork();
    runMigration314(db);
    runMigration317(db);
    const prs = new NeoWorkPrRepository(db);

    expect(prs.record('w1', [pr], 10)).toMatchObject({
      revision: 1,
      readAt: 10,
      readOkAt: 10,
      delivered: null,
    });
    expect(prs.record('w1', [pr], 20)).toMatchObject({ revision: 1, readAt: 20 });
    prs.markDelivered('w1', 'seen', 25);
    expect(prs.get('w1')).toMatchObject({ delivered: 'seen', deliveredAt: 25, reminded: null });
    prs.markDelivered('w1', 'seen', 26, true);
    expect(prs.get('w1')).toMatchObject({ deliveredAt: 26, reminded: 'seen' });
    expect(prs.record('w1', [{ ...pr, checks: 'passing' }], 30)).toMatchObject({
      revision: 2,
      delivered: 'seen',
      prs: [{ ...pr, checks: 'passing' }],
    });
    expect(prs.listOpen()).toEqual(['w1']);

    prs.recordFailedRead('w1', 35);
    expect(prs.get('w1')).toMatchObject({ readAt: 35, readOkAt: 30, revision: 2 });

    prs.record('w1', [{ ...pr, state: 'MERGED' }], 40);
    expect(prs.listOpen()).toEqual([]);
  });

  test('reads nothing before the migration has run', () => {
    const prs = new NeoWorkPrRepository(withWork());
    expect(prs.record('w1', [pr], 1)).toBe(null);
    expect(prs.listOpen()).toEqual([]);
  });
});
