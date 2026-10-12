import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import {
  neoAskReopensAfterClear,
  neoDaemonReadsClaim,
  neoNeedsYouClearedNote,
  neoResumeWhy,
  planNeoAskResume,
  planNeoNeedsYou,
  planNeoNeedsYouCleared,
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

describe('neoDaemonReadsClaim', () => {
  test.each<[string, string, boolean]>([
    ['a merge Neo can read', 'Issue filed with its fix merged to dev', true],
    ['a standing rule Neo can read', 'confirm the #6587 stopgap rule was removed', true],
    ['a deploy on this machine', 'The laptop runs the deploy', true],
    ['another machine', 'laptop and iMac deployed, read back over RPC', false],
    ['a plain claim', 'The photos look right', false],
  ])('%s', (_name, text, expected) => {
    expect(neoDaemonReadsClaim(text)).toBe(expected);
  });

  test('evidence about another machine keeps a reported claim', () => {
    expect(neoDaemonReadsClaim('merged to dev', 'The session says the iMac is updated.')).toBe(
      false
    );
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
