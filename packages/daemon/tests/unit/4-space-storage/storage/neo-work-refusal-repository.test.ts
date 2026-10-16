import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoWorkRefusalRepository } from '../../../../src/storage/repositories/neo-work-refusal-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

describe('NeoWorkRefusalRepository', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: NeoWorkRefusalRepository;
  const ref = { adapter: 'hyperneo-sessions', daemon: 'laptop', id: 's1' } as const;

  beforeEach(async () => {
    db = await createTestDb();
    repo = new NeoWorkRefusalRepository(db.getDatabase());
    const work = new NeoRepository(db.getDatabase());
    for (const workId of ['w1', 'w2']) {
      work.proposeWork({
        id: workId,
        requestKey: workId,
        projectId: null,
        originSessionId: 'neo',
        title: workId,
        instruction: workId,
      });
      repo.record({ workId, ref, what: `refused ${workId}`, at: 1 });
    }
  });
  afterEach(() => db.close());

  test('lists every refusal, or only those for the given cards', () => {
    expect(
      repo
        .list()
        .map((row) => row.workId)
        .sort()
    ).toEqual(['w1', 'w2']);
    expect(repo.list(['w2'])).toEqual([{ workId: 'w2', ref, what: 'refused w2', at: 1 }]);
    expect(repo.list([])).toEqual([]);
  });
});
