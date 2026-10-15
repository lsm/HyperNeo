import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { describe, expect, it } from 'vitest';
import { mergeNeoAskDetails } from '../neo-ask-detail.ts';

const ask = (extra: object = {}) => ({
  id: 'a',
  requestKey: 'a',
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm',
  title: 'Ask a',
  ask: 'Please a',
  doneWhen: 'Merged',
  doneSource: 'human' as const,
  status: 'achieved' as const,
  outcome: 'Merged in #12 with a long story.',
  workIds: ['w1'],
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  settledAt: 3,
  ...extra,
});
const work = (extra: object = {}) => ({
  id: 'w1',
  requestKey: 'w1',
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm',
  title: 'Card w1',
  instruction: 'Do w1',
  sessionId: 's1',
  status: 'reported' as const,
  report: 'Full report',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});
const card = (doneWhen: string | null) =>
  ({ workId: 'w1', doneWhen }) as NeoSnapshot['cards'][number];
const snapshot = (extra: Partial<NeoSnapshot>) =>
  ({
    ok: true,
    sessionId: 'root',
    projects: [],
    consultations: [],
    askViews: [],
    ...extra,
  }) as NeoSnapshot;

describe('mergeNeoAskDetails', () => {
  const summary = snapshot({
    asks: [ask({ ask: '', doneWhen: '', outcome: 'Merged', summarized: true })],
    work: [work({ instruction: '', report: 'Full', summarized: true, askId: 'a' })],
    cards: [card(null)],
  });
  const detail = snapshot({ asks: [ask()], work: [work()], cards: [card('Merged')] });

  it('swaps summarized asks, work and their cards for the loaded detail', () => {
    const merged = mergeNeoAskDetails(summary, new Map([['a', detail]]))!;
    expect(merged.asks).toEqual([ask()]);
    expect(merged.work).toEqual([work()]);
    expect(merged.cards).toEqual([card('Merged')]);
  });

  it('keeps the summary when the detail is older than what the snapshot now holds', () => {
    const moved = snapshot({
      asks: [ask({ revision: 4, summarized: true, doneWhen: '' })],
      work: [work({ status: 'failed', summarized: true, askId: 'a', instruction: '' })],
      cards: [card(null)],
    });
    expect(mergeNeoAskDetails(moved, new Map([['a', detail]]))).toEqual(moved);
  });

  it('leaves whole items alone and returns the snapshot untouched without details', () => {
    const whole = snapshot({
      asks: [ask({ doneWhen: 'Newer' })],
      work: [work()],
      cards: [card('x')],
    });
    expect(mergeNeoAskDetails(whole, new Map([['a', detail]]))).toEqual(whole);
    expect(mergeNeoAskDetails(summary, new Map())).toBe(summary);
    expect(mergeNeoAskDetails(null, new Map([['a', detail]]))).toBeNull();
  });
});
