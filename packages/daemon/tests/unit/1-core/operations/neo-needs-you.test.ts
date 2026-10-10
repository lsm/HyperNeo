import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { planNeoAskResume, planNeoNeedsYou } from '../../../../src/lib/neo/needs-you.ts';

const item = (id: string, state: NeoAskItem['state'], removed = false): NeoAskItem => ({
  id,
  text: `Item ${id}`,
  state,
  evidence: null,
  check: null,
  metBy: null,
  removed,
  addedAt: null,
});
const ask = {
  id: 'a1',
  status: 'waiting',
  doneItems: [item('i1', 'needs_you'), item('i2', 'met'), item('i3', 'needs_you', true)],
} as NeoAsk;

describe('planNeoAskResume', () => {
  test.each<[string, NeoAsk | null, ReturnType<typeof planNeoAskResume>]>([
    ['a waiting ask with a question item', ask, { ask, items: ['i1'], reopen: true }],
    [
      'a blocked ask with no question items',
      { ...ask, status: 'blocked', doneItems: [] },
      { ask: { ...ask, status: 'blocked', doneItems: [] }, items: [], reopen: true },
    ],
    ['an open ask with nothing to undo', { ...ask, status: 'open', doneItems: [] }, null],
    ['a settled ask', { ...ask, status: 'achieved' }, null],
    ['a card with no ask', null, null],
  ])('%s', (_label, current, plan) => {
    expect(planNeoAskResume(current)).toEqual(plan);
  });
});

describe('planNeoNeedsYou', () => {
  test.each<
    [
      string,
      Parameters<typeof planNeoNeedsYou>[0],
      number | null,
      ReturnType<typeof planNeoNeedsYou>,
    ]
  >([
    [
      'the session starts needing the human',
      { needsYou: true, since: 5 },
      null,
      { notify: 5, record: 5, resume: null },
    ],
    [
      'it still needs the human',
      { needsYou: true, since: 6 },
      5,
      { notify: null, record: undefined, resume: null },
    ],
    [
      'the human answered and it runs again',
      { needsYou: false, since: 7 },
      5,
      { notify: null, record: null, resume: { ask, items: ['i1'], reopen: true } },
    ],
    [
      'it was never waiting',
      { needsYou: false, since: 7 },
      null,
      { notify: null, record: undefined, resume: null },
    ],
    ['an unreadable status', null, 5, { notify: null, record: undefined, resume: null }],
  ])('%s', (_label, state, noted, plan) => {
    expect(planNeoNeedsYou(state, noted, ask)).toEqual(plan);
  });
});
