import { describe, expect, test } from 'bun:test';
import { orderWork } from '../../../../src/lib/work-queue/order.ts';

describe('orderWork', () => {
  test('puts higher priority first, then first come, then id', () => {
    const items = [
      { id: 'b', priority: 'normal' as const, createdAt: 2 },
      { id: 'a', priority: 'normal' as const, createdAt: 2 },
      { id: 'late-urgent', priority: 'urgent' as const, createdAt: 9 },
      { id: 'early-low', priority: 'low' as const, createdAt: 0 },
      { id: 'early', priority: 'normal' as const, createdAt: 1 },
    ];
    expect(orderWork(items).map((item) => item.id)).toEqual([
      'late-urgent',
      'early',
      'a',
      'b',
      'early-low',
    ]);
    expect(items[0].id).toBe('b');
  });
});
