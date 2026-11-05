import { describe, expect, test } from 'bun:test';
import type { RunningWork, WorkCandidate } from '../../../../src/lib/work-queue/capacity.ts';
import { createWorkQueue } from '../../../../src/lib/work-queue/sweep.ts';

type Claim = { id: string; plan: { kind: 'remind' | 'redispatch' | 'stall' } };

function world(plans: Record<string, Claim['plan']['kind']>, running: RunningWork[] = []) {
  const candidates: WorkCandidate[] = [];
  const started: string[] = [];
  const acted: string[] = [];
  const queue = createWorkQueue<Claim>(
    {
      queue: async () => ({ candidates, running }),
      claim: async (id, _now, mayMove) => {
        const kind = plans[id];
        if (!kind) return null;
        if (kind === 'redispatch' && !(await mayMove())) return null;
        return { id, plan: { kind } };
      },
      act: async (claim) => acted.push(`${claim.plan.kind}:${claim.id}`),
      start: async (id) => started.push(id),
    },
    () => ({ running: 2, perGroup: 2 })
  );
  return { queue, candidates, started, acted };
}

const candidate = (id: string, createdAt: number): WorkCandidate => ({
  id,
  group: 'p',
  priority: 'normal',
  createdAt,
  worker: null,
});

describe('work queue sweep', () => {
  test('moves at most one item a minute across follow-through and rescue', async () => {
    const w = world({ a: 'redispatch', b: 'redispatch' });
    await w.queue.followThrough('a', 0);
    await w.queue.followThrough('b', 30_000);
    expect(w.acted).toEqual(['redispatch:a']);
    expect(await w.queue.takeMove(59_000)).toBe(false);
    expect(await w.queue.takeMove(60_000)).toBe(true);
    await w.queue.followThrough('b', 90_000);
    expect(w.acted).toEqual(['redispatch:a']);
    await w.queue.followThrough('b', 120_000);
    expect(w.acted).toEqual(['redispatch:a', 'redispatch:b']);
  });

  test('reminders and stalls do not use up the move', async () => {
    const w = world({ a: 'remind', b: 'stall', c: 'redispatch' });
    await w.queue.followThrough('a', 0);
    await w.queue.followThrough('b', 0);
    await w.queue.followThrough('c', 0);
    expect(w.acted).toEqual(['remind:a', 'stall:b', 'redispatch:c']);
  });

  test('no move while busy workers fill the running cap', async () => {
    const w = world({ a: 'redispatch' }, [
      { group: 'p', worker: 'w1' },
      { group: 'p', worker: 'w2' },
    ]);
    await w.queue.followThrough('a', 0);
    expect(w.acted).toEqual([]);
  });

  test('fill starts waiting work in order up to the cap', async () => {
    const w = world({}, [{ group: 'p', worker: 'w1' }]);
    w.candidates.push(candidate('late', 2), candidate('early', 1));
    await w.queue.fill();
    expect(w.started).toEqual(['early']);
  });
});
