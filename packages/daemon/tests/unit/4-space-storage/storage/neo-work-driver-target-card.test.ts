import { describe, expect, test } from 'bun:test';
import { NeoWorkDriverTargetRepository } from '../../../../src/storage/repositories/neo-work-driver-target-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

function driverTargets(): Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_work_driver_targets (
    work_id TEXT PRIMARY KEY, target TEXT NOT NULL, ref TEXT, follow_anchor INTEGER,
    live_status TEXT, started_at INTEGER, retries INTEGER NOT NULL DEFAULT 0,
    start_interrupted INTEGER NOT NULL DEFAULT 0, needs_you_since INTEGER)`);
  return db;
}

describe('NeoWorkDriverTargetRepository.readCard', () => {
  test('reads every column of a card in one row and matches the single-column getters', () => {
    const db = driverTargets();
    const ref = { adapter: 'claude-desktop', id: 's1' };
    db.prepare(
      `INSERT INTO neo_work_driver_targets(work_id, target, ref, follow_anchor, live_status,
         started_at, retries, start_interrupted, needs_you_since)
       VALUES ('w1', ?, ?, 42, 'running', 100, 2, 1, 300)`
    ).run(JSON.stringify({ verb: 'send', ref }), JSON.stringify(ref));
    const repo = new NeoWorkDriverTargetRepository(db);
    const card = repo.readCard('w1');
    expect(card).toEqual({
      target: { verb: 'send', ref },
      ref,
      followAnchor: 42,
      liveStatus: 'running',
      startedAt: 100,
      retries: 2,
      startInterrupted: true,
      needsYouSince: 300,
    });
    expect(card?.target).toEqual(repo.get('w1'));
    expect(card?.ref).toEqual(repo.readRef('w1'));
    expect(card?.followAnchor).toBe(repo.readFollowAnchor('w1'));
    expect(card?.liveStatus).toBe(repo.readLiveStatus('w1'));
    expect(card?.startInterrupted).toBe(repo.readStartInterrupted('w1'));
  });

  test('an unstarted card reads empty columns, an unparseable target reads null, and a missing card is null', () => {
    const db = driverTargets();
    const start = {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'neokai' },
    } as const;
    db.prepare("INSERT INTO neo_work_driver_targets(work_id, target) VALUES ('fresh', ?)").run(
      JSON.stringify(start)
    );
    db.exec(
      `INSERT INTO neo_work_driver_targets(work_id, target) VALUES ('broken', '{"verb":"nope"}')`
    );
    const repo = new NeoWorkDriverTargetRepository(db);
    expect(repo.readCard('fresh')).toEqual({
      target: start,
      ref: null,
      followAnchor: null,
      liveStatus: null,
      startedAt: null,
      retries: 0,
      startInterrupted: false,
      needsYouSince: null,
    });
    expect(repo.readCard('broken')?.target).toBeNull();
    expect(repo.readCard('missing')).toBeNull();
    expect(new NeoWorkDriverTargetRepository(new Database(':memory:')).readCard('w1')).toBeNull();
  });
});
