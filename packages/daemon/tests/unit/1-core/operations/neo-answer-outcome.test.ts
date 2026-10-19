import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import {
  isNeoAskAnswerReady,
  planNeoAnswerPublished,
} from '../../../../src/lib/neo/answer-outcome.ts';
import { neoAskItemAction } from '../../../../src/lib/neo/ask-views.ts';

const item = (id: string, state: NeoAskItem['state'], extra: Partial<NeoAskItem> = {}) =>
  ({
    id,
    text: id,
    state,
    evidence: null,
    check: null,
    metBy: null,
    removed: false,
    addedAt: null,
    ...extra,
  }) as NeoAskItem;
const ask = (doneItems: NeoAskItem[], status: NeoAsk['status'] = 'open') =>
  ({ id: 'a1', status, doneItems }) as NeoAsk;
const answer = item('i2', 'reported', { outcomeKind: 'answer' });

describe('isNeoAskAnswerReady', () => {
  test('needs a reported answer and every other item met', () => {
    expect(isNeoAskAnswerReady(ask([item('i1', 'met'), answer]))).toBe(true);
    expect(isNeoAskAnswerReady(ask([item('i1', 'pending'), answer]))).toBe(false);
    expect(isNeoAskAnswerReady(ask([item('i1', 'met')]))).toBe(false);
  });

  test('an open question does not hold back a ready answer', () => {
    const question = item('i3', 'needs_you', { kind: 'decision', options: ['Yes', 'No'] });
    expect(isNeoAskAnswerReady(ask([item('i1', 'met'), answer, question]))).toBe(true);
  });
});

describe('planNeoAnswerPublished', () => {
  test('meets the reported answers', () => {
    expect(planNeoAnswerPublished(ask([item('i1', 'met'), answer]), 'p1')).toEqual({
      ticks: [{ item: answer, evidence: 'Answered the human in publication p1.' }],
    });
    expect(planNeoAnswerPublished(ask([answer], 'achieved'), 'p1')).toBeNull();
    expect(planNeoAnswerPublished(ask([item('i1', 'reported')]), 'p1')).toBeNull();
  });
});

describe('neoAskItemAction', () => {
  test('reported answers and states do not invent a confirmation question', () => {
    expect(neoAskItemAction(answer)).toBeNull();
    expect(neoAskItemAction(item('i1', 'reported'))).toBeNull();
  });
});
