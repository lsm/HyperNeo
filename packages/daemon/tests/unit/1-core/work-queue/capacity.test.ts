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
    ).toEqual({ start: ['urgent', 'old'], queued: ['new'] });
  });
});
