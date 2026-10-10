import { describe, expect, test } from 'bun:test';
import { NEO_CARD_UNCHECKED_MS, planNeoCardCheck } from '../../../../src/lib/neo/card-check.ts';

describe('planNeoCardCheck', () => {
  test('a card read in time stays checked and changes nothing', () => {
    const first = planNeoCardCheck(undefined, true, 1_000);
    expect(first).toEqual({ next: { checkedAt: 1_000, unchecked: false }, changed: false });
    expect(planNeoCardCheck(first.next, true, 61_000).changed).toBe(false);
  });

  test('failed reads mark the card unchecked once, after the window', () => {
    const ok = planNeoCardCheck(undefined, true, 0).next;
    const early = planNeoCardCheck(ok, false, NEO_CARD_UNCHECKED_MS);
    expect(early).toEqual({ next: { checkedAt: 0, unchecked: false }, changed: false });
    const late = planNeoCardCheck(early.next, false, NEO_CARD_UNCHECKED_MS + 1);
    expect(late).toEqual({ next: { checkedAt: 0, unchecked: true }, changed: true });
    expect(planNeoCardCheck(late.next, false, NEO_CARD_UNCHECKED_MS * 2).changed).toBe(false);
  });

  test('a read after a gap clears it, and a card first seen failing starts its window then', () => {
    const late = { checkedAt: 0, unchecked: true };
    expect(planNeoCardCheck(late, true, 999_999)).toEqual({
      next: { checkedAt: 999_999, unchecked: false },
      changed: true,
    });
    expect(planNeoCardCheck(undefined, false, 5)).toEqual({
      next: { checkedAt: 5, unchecked: false },
      changed: false,
    });
  });
});
