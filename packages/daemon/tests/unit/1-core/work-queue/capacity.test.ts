import { describe, expect, test } from 'bun:test';
import { planWorkQueue } from '../../../../src/lib/work-queue/capacity.ts';

const item = (id: string, priority: 'low' | 'normal' | 'high' | 'urgent', createdAt: number) => ({
  id,
  group: 'p',
  priority,
  createdAt,
  worker: null,
});

describe('planWorkQueue', () => {
  test('starts urgent work first, then first come, and queues the rest in that order', () => {
    expect(
      planWorkQueue(
        [item('old', 'normal', 1), item('urgent', 'urgent', 9), item('new', 'normal', 5)],
        [],
        { running: 2, perGroup: 2 }
      )
    ).toEqual({
      start: ['urgent', 'old'],
      queued: ['new'],
      reasons: { new: '2 workers running; total limit is 2' },
    });
  });
});

for (const [name, running, limits, reason] of [
  [
    'total',
    [{ group: 'other', worker: null }],
    { running: 1, perGroup: 5 },
    '1 workers running; total limit is 1',
  ],
  [
    'project',
    [{ group: 'p', worker: null }],
    { running: 5, perGroup: 1 },
    '1 workers running in this project; project limit is 1',
  ],
  [
    'idle worker',
    [{ group: 'p', worker: 'busy', idle: true }],
    { running: 1, perGroup: 1 },
    'the assigned worker is busy',
  ],
] as const) {
  test(`reports the ${name} hold reason`, () => {
    const candidate = { ...item('held', 'normal', 1), worker: 'busy' };
    expect(planWorkQueue([candidate], running, limits)).toEqual({
      start: [],
      queued: ['held'],
      reasons: { held: reason },
    });
  });
}
