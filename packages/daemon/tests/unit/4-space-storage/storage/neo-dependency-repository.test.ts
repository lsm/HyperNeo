import { runMigrations } from '../../../../src/storage/schema/migrations';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NeoAskRepository } from '../../../../src/storage/repositories/neo-ask-repository';
import { NeoDependencyRepository } from '../../../../src/storage/repositories/neo-dependency-repository';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { runMigration366 } from '../../../../src/storage/schema/m366-neo-work-dependencies';
import { createTestDb } from '../../../helpers/database';

const visible = new Set(['a', 'b', 'c']);

describe('NeoDependencyRepository', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let asks: NeoAskRepository;
  let work: NeoRepository;
  let graph: NeoDependencyRepository;
  const changed = mock(() => {});
  beforeEach(async () => {
    db = await createTestDb();
    asks = new NeoAskRepository(db.getDatabase());
    work = new NeoRepository(db.getDatabase());
    graph = new NeoDependencyRepository(db.getDatabase(), asks, changed);
    changed.mockClear();
    for (const id of visible) {
      work.proposeWork({
        id,
        requestKey: id,
        projectId: null,
        originSessionId: 'neo',
        title: id,
        instruction: id,
      });
      asks.open(
        {
          id: `ask-${id}`,
          requestKey: `ask-${id}`,
          projectId: null,
          originSessionId: 'neo',
          originMessageId: id,
          title: id,
          ask: id,
          doneWhen: id,
          doneSource: 'human',
        },
        [{ text: `Outcome ${id}`, check: null, deliveredBy: id }]
      );
      asks.approve(`ask-${id}`, 10, 0);
    }
  });
  afterEach(() => db.close());
  const replace = (
    workId: string,
    dependsOn: string[],
    expectedRevision = asks.forWork(workId)?.revision ?? 0
  ) => graph.replace({ workId, dependsOn, expectedRevision }, visible, 20);

  test('late cross-ask edges invalidate only the dependent approval and survive repository recreation', () => {
    const prerequisite = asks.get('ask-a');
    expect(replace('b', ['a'])).toEqual({ ok: true, revision: 1 });
    expect(asks.get('ask-a')).toEqual(prerequisite);
    expect(asks.get('ask-b')).toMatchObject({
      revision: 1,
      approvedAt: null,
      approvedRevision: null,
    });
    expect(new NeoDependencyRepository(db.getDatabase(), asks).edges()).toEqual([
      { workId: 'b', prerequisiteId: 'a' },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    asks.approve('ask-b', 30, 1);
    const approved = asks.get('ask-b');
    expect(replace('b', ['a'])).toEqual({ ok: true, revision: 1 });
    expect(asks.get('ask-b')).toEqual(approved);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(replace('b', [])).toEqual({ ok: true, revision: 2 });
    expect(graph.edges()).toEqual([]);
    expect(asks.get('ask-a')).toEqual(prerequisite);
  });

  test('same-ask edges advance that ask once, and reordering edges is a no-op', () => {
    asks.fold(
      asks.get('ask-b')!,
      asks.get('ask-a')!,
      [{ from: 'i1', id: 'i2', position: 1 }],
      'fold',
      11,
      true
    );
    const revision = asks.get('ask-a')!.revision!;
    expect(replace('b', ['a', 'c'])).toEqual({ ok: true, revision: revision + 1 });
    const before = asks.get('ask-a');
    expect(replace('b', ['c', 'a'])).toEqual({ ok: true, revision: revision + 1 });
    expect(asks.get('ask-a')).toEqual(before);
    expect(asks.get('ask-c')).toMatchObject({ revision: 0, approvedRevision: 0 });
  });

  test('rejects missing, invisible, duplicate, self and cyclic edges without partial writes', () => {
    replace('b', ['a']);
    replace('c', ['b']);
    const before = asks.list();
    const edges = graph.edges();
    for (const [id, deps, reason] of [
      ['a', ['c'], 'dependency_cycle'],
      ['a', ['a'], 'self_dependency'],
      ['b', ['a', 'a'], 'duplicate_dependency'],
      ['a', ['missing'], 'dependency_not_visible'],
    ] as const) {
      expect(replace(id, [...deps])).toEqual({ ok: false, reason });
    }
    expect(
      graph.replace({ workId: 'a', dependsOn: ['c'], expectedRevision: 0 }, new Set(['a']), 20)
    ).toEqual({ ok: false, reason: 'dependency_not_visible' });
    expect(replace('b', [], 0)).toEqual({ ok: false, reason: 'stale_ask_revision' });
    expect(asks.list()).toEqual(before);
    expect(graph.edges()).toEqual(edges);
  });

  test('missing or interaction-only outcomes cannot be endpoints; cancellation never revives a dependent', () => {
    db.getDatabase().exec("UPDATE neo_ask_items SET decision = 1 WHERE ask_id = 'ask-a'");
    expect(replace('b', ['a'])).toEqual({ ok: false, reason: 'dependency_outcomes_missing' });
    expect(replace('a', ['b'])).toEqual({ ok: false, reason: 'dependency_outcomes_missing' });
    db.getDatabase().exec("UPDATE neo_ask_items SET decision = 0 WHERE ask_id = 'ask-a'");
    replace('b', ['a']);
    work.transitionWork('b', work.getWork('b')!, { status: 'cancelled' });
    expect(replace('b', [])).toEqual({ ok: false, reason: 'dependent_cancelled' });
    expect(graph.blockers('b', () => true)).toEqual([
      { workId: 'b', reason: 'dependent_unavailable', itemIds: [] },
    ]);
    expect(graph.edges()).toEqual([{ workId: 'b', prerequisiteId: 'a' }]);
    expect(work.getWork('b')!.status).toBe('cancelled');
  });

  test('removing all dependent outcomes blocks existing edges without affecting independent cards', () => {
    replace('b', ['a']);
    db.getDatabase().exec(
      "UPDATE neo_ask_items SET removed = 1 WHERE ask_id IN ('ask-b', 'ask-c')"
    );
    expect(graph.blockers('b', () => true)).toEqual([
      { workId: 'b', reason: 'dependency_outcomes_missing', itemIds: [] },
    ]);
    expect(graph.blockers('c', () => true)).toEqual([]);
  });

  test('post-dispatch material edits are refused but identical edges are idempotent', () => {
    replace('b', ['a']);
    work.transitionWork('b', work.getWork('b')!, { status: 'queued' });
    expect(replace('b', ['a'])).toEqual({ ok: true, revision: 1 });
    expect(replace('b', ['c'])).toEqual({ ok: false, reason: 'dependency_already_dispatched' });
    expect(graph.edges()).toEqual([{ workId: 'b', prerequisiteId: 'a' }]);
  });

  test('blockers require bound, current, eligible evidence; empty outcomes never count as complete', () => {
    replace('b', ['a']);
    expect(graph.blockers('b')).toEqual([
      { workId: 'a', reason: 'outcomes_unverified', itemIds: ['i1'] },
    ]);
    const item = asks.get('ask-a')!.doneItems![0];
    asks.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'Worker claim', metBy: 'neo' },
      30,
      item
    );
    expect(graph.blockers('b', () => true)).toHaveLength(1);
    asks.tickItem(
      'ask-a',
      { ...item, state: 'met', evidence: 'Read independently', metBy: 'daemon' },
      31,
      item,
      true
    );
    expect(graph.blockers('b')).toHaveLength(1);
    expect(graph.blockers('b', () => true)).toEqual([]);
    db.getDatabase().exec("UPDATE neo_ask_items SET text = 'Changed' WHERE ask_id = 'ask-a'");
    expect(graph.blockers('b', () => true)).toHaveLength(1);
    db.getDatabase().exec("UPDATE neo_ask_items SET removed = 1 WHERE ask_id = 'ask-a'");
    expect(graph.blockers('b', () => true)).toEqual([
      { workId: 'a', reason: 'dependency_outcomes_missing', itemIds: [] },
    ]);
    work.transitionWork('a', work.getWork('a')!, { status: 'cancelled' });
    expect(graph.blockers('b', () => true)[0].reason).toBe('prerequisite_cancelled');
  });

  test('every bound item must verify and an interrupted handoff prevents edge edits', () => {
    replace('b', ['a']);
    const original = asks.get('ask-a')!.doneItems![0];
    asks.tickItem(
      'ask-a',
      { ...original, state: 'met', evidence: 'proof', metBy: 'daemon' },
      30,
      original,
      true
    );
    asks.editItems(
      'ask-a',
      {
        add: [{ id: 'i2', position: 1, text: 'Second output', check: null, deliveredBy: 'a' }],
        remove: [],
      },
      31,
      0
    );
    expect(graph.blockers('b', () => true)).toEqual([
      { workId: 'a', reason: 'outcomes_unverified', itemIds: ['i2'] },
    ]);
    db.getDatabase().exec(
      "INSERT INTO neo_work_driver_targets(work_id, target, started_at) VALUES ('c', '{}', 1)"
    );
    expect(replace('c', ['a'])).toEqual({ ok: false, reason: 'dependency_already_dispatched' });
  });

  test('write failures roll back edge replacement, revision and notifications', () => {
    replace('b', ['a']);
    const before = asks.get('ask-b');
    changed.mockClear();
    db.getDatabase().exec(
      "CREATE TRIGGER refuse_c BEFORE INSERT ON neo_work_dependencies WHEN NEW.prerequisite_id = 'c' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
    );
    expect(() => replace('b', ['c'])).toThrow('injected failure');
    expect(graph.edges()).toEqual([{ workId: 'b', prerequisiteId: 'a' }]);
    expect(asks.get('ask-b')).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });

  test('fold preserves stable edges and binds outcomes to the kept ask', () => {
    replace('b', ['a']);
    asks.fold(
      asks.get('ask-a')!,
      asks.get('ask-c')!,
      [{ from: 'i1', id: 'i2', position: 1 }],
      'folded',
      30,
      true
    );
    expect(graph.edges()).toEqual([{ workId: 'b', prerequisiteId: 'a' }]);
    expect(graph.blockers('b')).toEqual([
      { workId: 'a', reason: 'outcomes_unverified', itemIds: ['i2'] },
    ]);
    expect(asks.forWork('a')!.id).toBe('ask-c');
  });
});

describe('runMigration366', () => {
  test('is registered on fresh databases and reruns without losing edges', async () => {
    const db = await createTestDb();
    try {
      db.getDatabase().exec(
        "DROP TABLE neo_work_dependencies; DELETE FROM migration_markers WHERE key = 'migration_366'"
      );
      const backup = mock(() => {});
      runMigrations(db.getDatabase(), backup);
      expect(backup).toHaveBeenCalledTimes(1);
      expect(
        db
          .getDatabase()
          .prepare("SELECT key FROM migration_markers WHERE key = 'migration_366'")
          .get()
      ).toEqual({ key: 'migration_366' });
      const repo = new NeoRepository(db.getDatabase());
      for (const id of ['a', 'b'])
        repo.proposeWork({
          id,
          requestKey: id,
          projectId: null,
          originSessionId: 'neo',
          title: id,
          instruction: id,
        });
      db.getDatabase().exec("INSERT INTO neo_work_dependencies VALUES ('b', 'a')");
      runMigration366(db.getDatabase());
      expect(
        db
          .getDatabase()
          .prepare("SELECT name FROM sqlite_master WHERE name = 'neo_cross_project_dispatches'")
          .get()
      ).toBeTruthy();
      expect(db.getDatabase().prepare('SELECT * FROM neo_work_dependencies').all()).toEqual([
        { work_id: 'b', prerequisite_id: 'a' },
      ]);
      expect(() =>
        db.getDatabase().exec("INSERT INTO neo_work_dependencies VALUES ('a', 'a')")
      ).toThrow();
      expect(() =>
        db.getDatabase().exec("INSERT INTO neo_work_dependencies VALUES ('b', 'a')")
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
