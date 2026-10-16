import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoAskReopensAfterClear,
  neoAskTickedNote,
  neoHumanTickWakes,
  neoNeedsYouClearedNote,
  neoResumeWhy,
  planNeoAskResume,
  planNeoNeedsYou,
  planNeoNeedsYouCleared,
  planNeoQuestionsWithdrawn,
} from '../../../../src/lib/neo/needs-you.ts';

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
  test.each<[string, NeoAsk | null, ReturnType<typeof planNeoAskResume>, boolean?]>([
    ['a waiting ask with a question item', ask, { ask, items: ['i1'], reopen: true }],
    ['an ask another of its cards still waits on', ask, null, true],
    [
      'a blocked ask with no question items',
      { ...ask, status: 'blocked', doneItems: [] },
      { ask: { ...ask, status: 'blocked', doneItems: [] }, items: [], reopen: true },
    ],
    [
      'a decision the ask was settled waiting on stays, whatever its evidence says',
      {
        ...ask,
        waitingItem: 'i4',
        evidence: 'Item i4',
        doneItems: [item('i1', 'needs_you'), { ...item('i4', 'needs_you'), decision: true }],
      },
      {
        ask: {
          ...ask,
          waitingItem: 'i4',
          evidence: 'Item i4',
          doneItems: [item('i1', 'needs_you'), { ...item('i4', 'needs_you'), decision: true }],
        },
        items: ['i1'],
        reopen: false,
      },
    ],
    [
      'a question a tick put the ask waiting on is reset',
      { ...ask, waitingItem: 'i1', evidence: 'Other words', doneItems: [item('i1', 'needs_you')] },
      {
        ask: {
          ...ask,
          waitingItem: 'i1',
          evidence: 'Other words',
          doneItems: [item('i1', 'needs_you')],
        },
        items: ['i1'],
        reopen: true,
      },
    ],
    [
      'an ask waiting on the human to confirm a reported item',
      { ...ask, waitingItem: 'i4', doneItems: [item('i2', 'met'), item('i4', 'reported')] },
      null,
    ],
    ['an open ask with nothing to undo', { ...ask, status: 'open', doneItems: [] }, null],
    ['a settled ask', { ...ask, status: 'achieved' }, null],
    ['a card with no ask', null, null],
  ])('%s', (_label, current, plan, siblingsWaiting = false) => {
    expect(planNeoAskResume(current, siblingsWaiting)).toEqual(plan);
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

  test('keeps the ask waiting while another of its cards still needs the human', () => {
    expect(planNeoNeedsYou({ needsYou: false, since: 7 }, 5, ask, true)).toEqual({
      notify: null,
      record: null,
      resume: null,
    });
  });
});

describe('planNeoAskResume for one card', () => {
  test('keeps an item that cites another card, and the ask stays waiting on it', () => {
    const cited = {
      ...ask,
      doneItems: [{ ...item('i1', 'needs_you'), waitCard: 'w2' }, item('i2', 'needs_you')],
    } as NeoAsk;
    expect(planNeoAskResume(cited, false, 'w1')).toEqual({
      ask: cited,
      items: ['i2'],
      reopen: false,
    });
    expect(planNeoAskResume(cited, false, 'w2')).toEqual({
      ask: cited,
      items: ['i1', 'i2'],
      reopen: true,
    });
  });
});

describe('planNeoNeedsYouCleared', () => {
  const now = 1_000_000;
  const card = (status: string, needsYou = false, stalled = false) => ({
    status,
    needsYou,
    stalled,
  });
  const waiting = (overrides: Partial<NeoAskItem>, askOverrides: Partial<NeoAsk> = {}): NeoAsk =>
    ({
      ...ask,
      workIds: ['w1', 'w2'],
      approvedAt: null,
      ...askOverrides,
      doneItems: [{ ...item('i1', 'needs_you'), ...overrides }],
    }) as NeoAsk;

  test('a cited card that started or reported clears its item', () => {
    const cited = waiting({ kind: 'action', waitCard: 'w1' });
    expect(planNeoNeedsYouCleared(cited, new Map([['w1', card('queued')]]), now)).toEqual([
      { id: 'i1', why: 'card w1 no longer waits on the human' },
    ]);
    expect(planNeoNeedsYouCleared(cited, new Map([['w1', card('reported')]]), now)).toHaveLength(1);
  });

  test('a cited card still waiting for Start or the human keeps its item', () => {
    const cited = waiting({ kind: 'action', waitCard: 'w1' });
    expect(planNeoNeedsYouCleared(cited, new Map([['w1', card('proposed')]]), now)).toEqual([]);
    expect(planNeoNeedsYouCleared(cited, new Map([['w1', card('queued', true)]]), now)).toEqual([]);
  });

  test('a decision, a kinded item with no card, or an item with options stays for the human', () => {
    const done = new Map([['w2', card('reported')]]);
    for (const overrides of [
      { waitCard: 'w1', decision: true as const },
      { kind: 'decision' as const },
      { kind: 'action' as const },
      { options: ['Yes', 'No'] },
    ])
      expect(planNeoNeedsYouCleared(waiting(overrides), done, now)).toEqual([]);
  });

  test('an older item without a kind clears, in any language, once no card waits on the human', () => {
    const start = waiting({ text: '等待你在 Work 卡上点 Start work 以开始 UI 核查。' });
    expect(planNeoNeedsYouCleared(start, new Map([['w1', card('reported')]]), now)).toEqual([
      { id: 'i1', why: 'no card under this ask is proposed or waits on the human' },
    ]);
    expect(planNeoNeedsYouCleared(start, new Map([['w1', card('proposed')]]), now)).toEqual([]);
    expect(planNeoNeedsYouCleared(start, new Map([['w1', card('queued', true)]]), now)).toEqual([]);
  });

  test('an older item clears under an active approval unless a card stalled', () => {
    const approved = waiting({ text: 'Approve another continuation' }, { approvedAt: now - 1000 });
    const cards = (stalled: boolean) =>
      new Map([
        ['w1', card('proposed')],
        ['w2', card('queued', false, stalled)],
      ]);
    expect(planNeoNeedsYouCleared(approved, cards(false), now)).toEqual([
      { id: 'i1', why: "the ask's approval is active and none of its cards has stalled" },
    ]);
    expect(planNeoNeedsYouCleared(approved, cards(true), now)).toEqual([]);
    expect(
      planNeoNeedsYouCleared({ ...approved, approvedAt: null } as NeoAsk, cards(false), now)
    ).toEqual([]);
  });

  test('an older item on an ask without cards stays for the human', () => {
    expect(
      planNeoNeedsYouCleared(
        waiting({ text: 'Which name do you want?' }, { workIds: [] }),
        new Map(),
        now
      )
    ).toEqual([]);
  });

  test('items that are not waiting on the human stay as they are', () => {
    const met = waiting({ state: 'met', waitCard: 'w1' });
    expect(planNeoNeedsYouCleared(met, new Map(), now)).toEqual([]);
  });
});

describe('neoNeedsYouClearedNote', () => {
  test('the note names each cleared item and why', () => {
    const note = neoNeedsYouClearedNote(
      { id: 'a1', title: 'Ship it' },
      [{ id: 'i1', why: 'card w1 no longer waits on the human' }],
      [item('i1', 'pending')]
    );
    expect(note).toContain('i1 "Item i1": card w1 no longer waits on the human.');
    expect(note).toContain('ask a1 ("Ship it")');
  });
});

describe('neoResumeWhy', () => {
  test('names the cited card, or says an uncited question may be answered', () => {
    expect(neoResumeWhy({ waitCard: 'w1' }, 'w1')).toBe(
      'card w1, which it cites, no longer waits on the human'
    );
    expect(neoResumeWhy({}, 'w1')).toContain('it cites no card');
  });
});

describe('neoAskReopensAfterClear', () => {
  test('a blocked ask with nothing left for the human reopens', () => {
    const blocked = { ...ask, status: 'blocked', doneItems: [item('i1', 'pending')] } as NeoAsk;
    expect(neoAskReopensAfterClear(blocked)).toBe(true);
    expect(
      neoAskReopensAfterClear({ ...blocked, doneItems: [item('i1', 'needs_you')] } as NeoAsk)
    ).toBe(false);
    expect(neoAskReopensAfterClear({ ...blocked, status: 'waiting' } as NeoAsk)).toBe(false);
  });
});

describe('neoHumanTickWakes', () => {
  test('wakes Neo only when someone else marks an unmet item met', () => {
    expect(neoHumanTickWakes('met', 'rpc', { state: 'reported' })).toBe(true);
    expect(neoHumanTickWakes('met', 'rpc', { state: 'met' })).toBe(false);
    expect(neoHumanTickWakes('met', 'mcp', { state: 'pending' })).toBe(false);
    expect(neoHumanTickWakes('pending', 'rpc', { state: 'needs_you' })).toBe(false);
  });
});

describe('neoAskTickedNote', () => {
  test('names what is still open, or that every item is met', () => {
    const open = {
      ...ask,
      title: 'Ship it',
      doneItems: [item('i1', 'met'), item('i2', 'pending')],
    };
    expect(neoAskTickedNote(open, item('i1', 'met'))).toContain(
      'Still open: i2 "Item i2" (pending)'
    );
    const done = { ...open, doneItems: [item('i1', 'met')] };
    expect(neoAskTickedNote(done, item('i1', 'met'))).toContain('Every item is met.');
  });
});

describe('planNeoQuestionsWithdrawn', () => {
  const asked = (reason: 'target_unavailable' | 'card_waits' | 'card_failed'): NeoAskItem => ({
    ...item('i3', 'needs_you'),
    decision: true,
    because: { card: 'c1', reason },
  });
  const card = (status: string, extra: { needsYou?: boolean; targetReady?: boolean } = {}) =>
    new Map([['c1', { status, needsYou: false, stalled: false, ...extra }]]);

  test.each([
    [
      'target_unavailable',
      card('failed', { targetReady: true }),
      'card c1 can reach its target again',
    ],
    ['target_unavailable', card('failed', { targetReady: false }), null],
    ['card_waits', card('queued', { needsYou: false }), 'card c1 no longer waits on the human'],
    ['card_waits', card('queued', { needsYou: true }), null],
    ['card_failed', card('running'), 'card c1 is running, not failed'],
    ['card_failed', card('failed', { targetReady: true }), null],
    ['card_failed', new Map(), null],
  ] as const)('%s → %s', (reason, cards, why) => {
    expect(planNeoQuestionsWithdrawn({ doneItems: [asked(reason)] }, cards)).toEqual(
      why ? [{ id: 'i3', why }] : []
    );
  });

  test('leaves questions without a reason, answered and removed ones alone', () => {
    const cards = card('running', { targetReady: true });
    expect(
      planNeoQuestionsWithdrawn(
        {
          doneItems: [
            { ...item('i1', 'needs_you'), decision: true },
            { ...asked('card_failed'), id: 'i2', state: 'met' },
            { ...asked('card_failed'), id: 'i4', removed: true },
          ],
        },
        cards
      )
    ).toEqual([]);
  });
});
