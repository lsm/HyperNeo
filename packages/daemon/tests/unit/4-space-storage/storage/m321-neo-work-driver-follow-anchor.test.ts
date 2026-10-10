import { describe, expect, test } from 'bun:test';
import { runMigration321 } from '../../../../src/storage/schema/m321-neo-work-driver-follow-anchor';
import { NeoWorkDriverTargetRepository } from '../../../../src/storage/repositories/neo-work-driver-target-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

function columns(db: Database): string[] {
  return (
    db.prepare('PRAGMA table_info(neo_work_driver_targets)').all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function driverTargets(): Database {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE neo_work_driver_targets (work_id TEXT PRIMARY KEY, target TEXT, ref TEXT, started_at INTEGER)'
  );
  return db;
}

describe('runMigration321', () => {
  test('adds the follow anchor column once, and skips databases without driver targets', () => {
    const db = driverTargets();
    runMigration321(db);
    runMigration321(db);
    expect(columns(db)).toEqual(['work_id', 'target', 'ref', 'started_at', 'follow_anchor']);
    const bare = new Database(':memory:');
    runMigration321(bare);
    expect(columns(bare)).toEqual([]);
  });
});

describe('NeoWorkDriverTargetRepository follow ownership', () => {
  test('the follow anchor survives a new repository instance', () => {
    const db = driverTargets();
    runMigration321(db);
    db.exec("INSERT INTO neo_work_driver_targets(work_id, target) VALUES ('w1', '{}')");
    new NeoWorkDriverTargetRepository(db).recordFollowAnchor('w1', 42);
    expect(new NeoWorkDriverTargetRepository(db).readFollowAnchor('w1')).toBe(42);
    expect(new NeoWorkDriverTargetRepository(db).readFollowAnchor('missing')).toBeNull();
  });

  test('a card is superseded once a newer card lands on the same session', () => {
    const db = driverTargets();
    runMigration321(db);
    const insert = db.prepare(
      'INSERT INTO neo_work_driver_targets(work_id, target, ref, started_at) VALUES (?, ?, ?, ?)'
    );
    const shared = JSON.stringify({ adapter: 'claude-desktop', id: 's1' });
    insert.run('older', '{}', shared, 100);
    insert.run('newer', '{}', shared, 200);
    insert.run('elsewhere', '{}', JSON.stringify({ adapter: 'claude-desktop', id: 's2' }), 300);
    insert.run('unlanded', '{}', shared, null);
    const repo = new NeoWorkDriverTargetRepository(db);
    expect(repo.readSupersededAt('older')).toBe(200);
    expect(repo.readSupersededAt('newer')).toBeNull();
    expect(repo.readSupersededAt('elsewhere')).toBeNull();
    expect(repo.readSupersededAt('unlanded')).toBeNull();
  });
});
