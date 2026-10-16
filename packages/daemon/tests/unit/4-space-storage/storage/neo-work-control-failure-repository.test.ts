import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { NeoWorkControlFailureRepository } from '../../../../src/storage/repositories/neo-work-control-failure-repository';
import { runMigration386 } from '../../../../src/storage/schema/m386-neo-work-control-failures';
import { createTestDb } from '../../../helpers/database';

const ref = { adapter: 'claude-desktop', daemon: 'laptop', id: 'local_one' };
const failure = {
  workId: 'w1',
  ref,
  operation: 'stop' as const,
  reason: 'unsupported' as const,
  detail: 'Open Desktop.',
  at: 1,
};

describe('NeoWorkControlFailureRepository', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: NeoWorkControlFailureRepository;
  beforeEach(async () => {
    db = await createTestDb();
    repo = new NeoWorkControlFailureRepository(db.getDatabase());
    new NeoRepository(db.getDatabase()).proposeWork({
      id: 'w1',
      requestKey: 'w1',
      projectId: null,
      originSessionId: 'neo',
      title: 'work',
      instruction: 'work',
    });
  });
  afterEach(() => db.close());

  test('round-trips failure facts separately from request cancellation', () => {
    repo.record(failure);
    const work = new NeoRepository(db.getDatabase());
    work.transitionWork('w1', work.getWork('w1')!, { status: 'cancelled' });
    expect(repo.list(['w1'])).toEqual([failure]);
    expect(repo.list(['other'])).toEqual([]);
    expect(repo.list([])).toEqual([]);
    expect(work.getWork('w1')?.status).toBe('cancelled');
    runMigration386(db.getDatabase());
    expect(new NeoWorkControlFailureRepository(db.getDatabase()).list()).toEqual([failure]);
  });

  test('replaces an operation fact while retaining a separate withdrawal fact', () => {
    repo.record(failure);
    repo.record({ ...failure, operation: 'withdraw' });
    repo.record({ ...failure, reason: 'unavailable', detail: 'Connection lost.', at: 2 });
    expect(repo.list()).toHaveLength(2);
    expect(repo.list().find((row) => row.operation === 'stop')).toMatchObject({
      reason: 'unavailable',
      at: 2,
    });
  });

  test('clears only the matching target and operation after verified success', () => {
    repo.record(failure);
    expect(repo.clear('w1', { ...ref, id: 'replacement' }, 'stop')).toBe(false);
    expect(repo.clear('w1', { ...ref, daemon: 'other' }, 'stop')).toBe(false);
    expect(repo.clear('w1', ref, 'withdraw')).toBe(false);
    expect(repo.list()).toEqual([failure]);
    expect(repo.clear('w1', { id: ref.id, daemon: ref.daemon, adapter: ref.adapter }, 'stop')).toBe(
      true
    );
    expect(repo.list()).toEqual([]);
  });

  test('migrates an existing database without changing cancellation or old facts', () => {
    db.getDatabase().exec('DROP TABLE neo_work_control_failures');
    runMigration386(db.getDatabase());
    repo.record(failure);
    db.getDatabase().prepare('DELETE FROM neo_work WHERE id = ?').run('w1');
    expect(repo.list()).toEqual([]);
  });
});
