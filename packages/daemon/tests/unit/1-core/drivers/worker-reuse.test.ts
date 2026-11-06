import { describe, expect, test } from 'bun:test';
import {
  chooseReusableWorker,
  type WorkerReuseCandidate,
} from '../../../../src/lib/drivers/worker-reuse';

const request = { adapter: 'fixture', folder: '/synthetic', refreshStatus: true };
const candidate = (
  id: string,
  patch: Partial<WorkerReuseCandidate> = {}
): WorkerReuseCandidate => ({
  work: {
    ref: { adapter: 'fixture', id },
    title: id,
    place: { machine: 'fixture', folder: '/synthetic', name: 'Fixture' },
    status: 'done',
    lastActivityAt: 1,
  },
  free: true,
  sameAskAt: null,
  settledAt: null,
  ...patch,
});

describe('chooseReusableWorker', () => {
  test('keeps discovery order on equal facts and never mutates candidates', () => {
    const workers = [candidate('first'), candidate('second')];
    const before = structuredClone(workers);
    expect(chooseReusableWorker(workers, request)).toBe(workers[0]);
    expect(workers).toEqual(before);
  });

  test('prefers same-ask recency over other-ask settlement age', () => {
    const workers = [
      candidate('settled', { settledAt: 1 }),
      candidate('prior', { sameAskAt: 5 }),
      candidate('latest', { sameAskAt: 9 }),
    ];
    expect(chooseReusableWorker(workers, request)?.work.ref.id).toBe('latest');
  });

  test('requires a local, free, matching-adapter and matching-folder candidate', () => {
    const original = candidate('wrong');
    for (const worker of [
      { ...original, free: false },
      { ...original, work: { ...original.work, ref: { adapter: 'other', id: 'wrong' } } },
      { ...original, work: { ...original.work, ref: { ...original.work.ref, daemon: 'remote' } } },
      {
        ...original,
        work: { ...original.work, place: { ...original.work.place, folder: '/other' } },
      },
      { ...original, work: { ...original.work, status: 'failed' as const } },
    ])
      expect(chooseReusableWorker([worker], request)).toBeUndefined();
  });

  test('running discovery requires live refresh, and exclusions outrank affinity', () => {
    const running = candidate('busy', { sameAskAt: 100 });
    running.work.status = 'running';
    expect(chooseReusableWorker([running], { ...request, refreshStatus: false })).toBeUndefined();
    expect(chooseReusableWorker([running], request)).toBe(running);
    expect(
      chooseReusableWorker([running], { ...request, excludeRefs: [running.work.ref] })
    ).toBeUndefined();
  });
});
