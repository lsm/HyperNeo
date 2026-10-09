import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import {
  projectNeoSnapshotAsks,
  requireNeoAskConcern,
  isNeoAskReplay,
  planNeoAskWorkStops,
  planNeoCardAsk,
  isNeoCardAsk,
  requireNeoAskReceipt,
  requireNeoAskSettlement,
  requireNeoAskWritten,
  requireNeoWorkAsk,
  requireNeoWorkAskLink,
} from '../../../../src/lib/neo/ask-operations.ts';
import { driverDoneCheckNote, neoWorkDoneGoal } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const neo: OperationCaller = {
  source: 'mcp',
  sessionId: 'root',
  role: 'neo',
  neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
};
const place = { machine: 'laptop', folder: tmpdir(), name: 'app' };
const opening = {
  requestKey: 'fix',
  title: 'Fix the login bug',
  ask: 'Fix the login bug and get it merged',
  doneWhen: '- merged to dev\n- CI green',
  doneSource: 'human',
};

describe('neo.ask operations', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('root'));
    service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    service.repo.reserveBinding({ sessionId: 'root', kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  function invoke(name: string, input: unknown, caller: OperationCaller = neo) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      caller
    ) as Promise<{
      kind: string;
      value?: { ok: boolean; ask?: NeoAsk; asks?: NeoAsk[]; work?: { id: string } };
    }>;
  }

  async function openAsk(): Promise<string> {
    const opened = await invoke('neo.ask.open', opening);
    return opened.value!.ask!.id;
  }

  function propose(requestKey: string, askId: string) {
    return invoke('neo.work.propose', {
      requestKey,
      title: 'Fix it',
      instruction: 'Fix the login bug.',
      work: { verb: 'start', adapter: 'claude-desktop', place },
      askId,
    });
  }

  test('opens one ask per request key and shows its cards in the snapshot', async () => {
    const askId = await openAsk();
    expect(await invoke('neo.ask.open', opening)).toMatchObject({
      value: { ok: true, ask: { id: askId, originMessageId: 'ask-1', status: 'open' } },
    });
    for (const change of [{ ask: 'Something else' }, { doneWhen: '- PR open' }])
      expect(await invoke('neo.ask.open', { ...opening, ...change })).toMatchObject({
        value: { ok: false, reason: 'This request key already belongs to another ask.' },
      });

    const proposed = await propose('card-1', askId);
    const workId = proposed.value!.work!.id;
    const snapshot = await invoke('neo.snapshot', {});

    expect(snapshot.value?.asks).toEqual([
      expect.objectContaining({ id: askId, doneWhen: opening.doneWhen, workIds: [workId] }),
    ]);
  });

  test('refuses work under a missing or achieved ask, and settling is final', async () => {
    const askId = await openAsk();
    expect(await propose('card-1', 'nope')).toMatchObject({
      value: { ok: false, reason: 'ask_not_found' },
    });

    const settle = { id: askId, outcome: 'achieved', evidence: 'PR #12 merged, CI green.' };
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({
      value: { ok: true, ask: { status: 'achieved', outcome: settle.evidence } },
    });
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({ value: { ok: true } });
    expect(
      await invoke('neo.ask.settle', { ...settle, outcome: 'blocked', evidence: 'x' })
    ).toMatchObject({ value: { ok: false, reason: 'ask_settled: this ask is already achieved.' } });
    expect(await propose('card-2', askId)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('ask_settled') },
    });
  });
  test('new work under a blocked ask reopens it', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.settle', { id: askId, outcome: 'blocked', evidence: 'Which API?' });

    await propose('card-1', askId);

    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open', settledAt: null });
  });

  test("settling for good stops its live work; only the user can settle another session's ask", async () => {
    const askId = await openAsk();
    const running = (await propose('card-1', askId)).value!.work!.id;
    const idle = (await propose('card-2', askId)).value!.work!.id;
    const work = service.repo.getWork(running)!;
    service.repo.transitionWork(work.id, work, { status: 'queued' });

    expect(
      await invoke(
        'neo.ask.settle',
        { id: askId, outcome: 'abandoned', evidence: 'x' },
        {
          ...neo,
          sessionId: 'other',
        }
      )
    ).toMatchObject({ value: { ok: false } });
    expect(
      await invoke(
        'neo.ask.settle',
        { id: askId, outcome: 'abandoned', evidence: 'Closed by the user.' },
        { source: 'rpc', principal: 'local' }
      )
    ).toMatchObject({ value: { ok: true, ask: { status: 'abandoned' } } });
    expect(service.repo.getWork(running)?.status).toBe('cancelled');
    expect(service.repo.getWork(idle)?.status).toBe('cancelled');
  });

  test('opens an ask from a card proposed with a done list and no ask', async () => {
    const card = {
      title: 'Fix #5555',
      instruction: 'Fix it.',
      work: { verb: 'start', adapter: 'claude-desktop', place },
      goal: 'Remove the write-only field',
      doneWhen: '- merged to dev',
    };
    const first = await invoke('neo.work.propose', { ...card, requestKey: 'card-1' });
    await invoke('neo.work.propose', { ...card, requestKey: 'card-1' });
    await invoke('neo.work.propose', { ...card, requestKey: 'card-2', doneWhen: undefined });

    const asks = service.askRecords.list();
    expect(asks).toEqual([
      expect.objectContaining({
        ask: 'Remove the write-only field',
        doneWhen: '- merged to dev',
        doneSource: 'card',
        workIds: [first.value!.work!.id],
      }),
    ]);
  });

  test('refuses a retried request key under another ask', async () => {
    const first = await openAsk();
    const second = (await invoke('neo.ask.open', { ...opening, requestKey: 'other' })).value!.ask!
      .id;
    await propose('card-1', first);

    const refused = await invoke('neo.work.propose', {
      requestKey: 'card-1',
      title: 'Fix it',
      instruction: 'Fix the login bug.',
      work: { verb: 'start', adapter: 'claude-desktop', place },
      askId: second,
      goal: 'Something else',
      doneWhen: '- deployed',
    });
    expect(refused).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('another ask') },
    });
    expect(service.workGoals.get(service.askRecords.get(first)!.workIds[0])).toBe(null);
    expect(service.askRecords.get(second)?.workIds).toEqual([]);
    expect(await propose('card-1', first)).toMatchObject({ value: { ok: true } });
  });
});

const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'root:fix',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'm1',
  title: opening.title,
  ask: opening.ask,
  doneWhen: opening.doneWhen,
  doneSource: 'human',
  status: 'open',
  outcome: null,
  workIds: [],
  createdAt: 1,
  updatedAt: 1,
  settledAt: null,
};
const openInput = { ...opening, concernId: null };

describe('requireNeoAskReceipt', () => {
  test.each([
    ['no ask table', null, 'Asks are not available on this daemon yet.'],
    [
      'another done rule',
      { ...ask, doneWhen: '- PR open' },
      'This request key already belongs to another ask.',
    ],
    [
      'another concern',
      { ...ask, concernId: 'c1' },
      'This request key already belongs to another ask.',
    ],
  ])('refuses %s', (_case, opened, reason) => {
    expect(requireNeoAskReceipt(openInput, { ask: opened })).toEqual({
      reason: { ok: false, reason },
    });
  });

  test('accepts the same ask', () => {
    expect(requireNeoAskReceipt(openInput, { ask })).toEqual({ value: { ok: true, ask } });
  });
});

describe('requireNeoAskConcern', () => {
  test('refuses a missing concern and passes the value otherwise', () => {
    expect(requireNeoAskConcern({ concernId: 'c1' }, { concern: null }, 'v')).toEqual({
      reason: { ok: false, reason: 'Concern not found.' },
    });
    expect(requireNeoAskConcern({ concernId: null }, { concern: null }, 'v')).toEqual({
      value: 'v',
    });
  });
});

describe('requireNeoWorkAsk', () => {
  const input = { askId: 'a1', concernId: null };

  test.each([
    ['a missing ask', null, 'ask_not_found'],
    [
      'another concern',
      { ...ask, concernId: 'c1' },
      'This ask belongs to another concern; propose under its concernId.',
    ],
    [
      'an achieved ask',
      { ...ask, status: 'achieved' as const },
      'ask_settled: this ask is already achieved; open a new ask.',
    ],
  ])('refuses work under %s', (_case, current, reason) => {
    expect(requireNeoWorkAsk(current, input, neo)).toEqual({ reason: { ok: false, reason } });
  });

  test('refuses another Neo session filing work under the ask, but not the user', () => {
    expect(requireNeoWorkAsk(ask, input, { ...neo, sessionId: 'holder' })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('open your own ask') },
    });
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    expect(requireNeoWorkAsk(ask, input, user)).toEqual({ value: user });
  });

  test('passes work with no ask or under an active one', () => {
    expect(requireNeoWorkAsk(null, { concernId: null }, neo)).toEqual({ value: neo });
    expect(requireNeoWorkAsk({ ...ask, status: 'blocked' }, input, neo)).toEqual({ value: neo });
  });
});

describe('requireNeoWorkAskLink', () => {
  test('passes work with no ask or linked to its ask, refuses work owned by another', () => {
    expect(requireNeoWorkAskLink({}, { owner: null }, 'r')).toEqual({ value: 'r' });
    expect(requireNeoWorkAskLink({ askId: 'a1' }, { owner: 'a1' }, 'r')).toEqual({ value: 'r' });
    expect(requireNeoWorkAskLink({ askId: 'a1' }, { owner: 'a2' }, 'r')).toMatchObject({
      reason: { ok: false },
    });
  });
});

describe('projectNeoSnapshotAsks', () => {
  test('keeps every active ask ahead of the most recent settled ones', () => {
    const asks = [
      { ...ask, id: 's1', status: 'achieved' as const },
      { ...ask, id: 'o1' },
      { ...ask, id: 's2', status: 'abandoned' as const },
      { ...ask, id: 'b1', status: 'blocked' as const },
    ];
    expect(projectNeoSnapshotAsks(asks, 1).map((item) => item.id)).toEqual(['o1', 'b1', 's1']);
  });
});

describe('requireNeoAskSettlement', () => {
  const settle = { id: 'a1', outcome: 'achieved' as const, evidence: 'PR merged.' };
  const done = { ...ask, status: 'achieved' as const, outcome: 'PR merged.' };

  test.each([
    ['a missing ask', null, neo, 'ask_not_found'],
    [
      'another Neo session',
      ask,
      { ...neo, sessionId: 'other' },
      'Only the Neo session that opened this ask or the user can settle it.',
    ],
    [
      'a different outcome on a final ask',
      { ...done, outcome: 'Other.' },
      neo,
      'ask_settled: this ask is already achieved.',
    ],
  ])('refuses %s', (_case, current, caller, reason) => {
    expect(requireNeoAskSettlement(settle, { ask: current }, caller)).toEqual({
      reason: { ok: false, reason },
    });
  });

  test('admits an open ask and an identical replay', () => {
    expect(requireNeoAskSettlement(settle, { ask }, neo)).toEqual({ value: ask });
    expect(requireNeoAskSettlement(settle, { ask: done }, neo)).toEqual({ value: done });
    expect(isNeoAskReplay(done, settle)).toBe(true);
  });
});
describe('requireNeoAskWritten', () => {
  test('reports a lost write as superseded', () => {
    expect(requireNeoAskWritten({ ask: null })).toEqual({
      reason: { ok: false, reason: 'This ask changed; read it again.' },
    });
    expect(requireNeoAskWritten({ ask })).toEqual({ value: { ok: true, ask } });
  });
});

describe('planNeoAskWorkStops', () => {
  const works = [
    { id: 'q', status: 'queued' as const },
    { id: 'p', status: 'proposed' as const },
    { id: 'r', status: 'reported' as const },
  ];

  test.each<[string, 'achieved' | 'abandoned' | 'blocked', ReturnType<typeof planNeoAskWorkStops>]>(
    [
      [
        'achieved closes queued work as done',
        'achieved',
        [
          { id: 'q', close: 'done' },
          { id: 'p', close: 'cancelled' },
        ],
      ],
      [
        'abandoned cancels live work',
        'abandoned',
        [
          { id: 'q', close: 'cancelled' },
          { id: 'p', close: 'cancelled' },
        ],
      ],
      ['blocked leaves work alone', 'blocked', []],
    ]
  )('%s', (_case, outcome, stops) => {
    expect(planNeoAskWorkStops(works, outcome)).toEqual(stops);
  });
});

describe('neoWorkDoneGoal', () => {
  test('prefers the card checklist and falls back to its ask', () => {
    expect(neoWorkDoneGoal('w', { workId: 'w', goal: 'Card', doneWhen: '- card' }, ask)).toEqual({
      workId: 'w',
      goal: 'Card',
      doneWhen: '- card',
    });
    expect(neoWorkDoneGoal('w', null, ask)).toEqual({
      workId: 'w',
      goal: ask.ask,
      doneWhen: ask.doneWhen,
    });
    expect(neoWorkDoneGoal('w', null, null)).toBe(null);
  });
});

describe('neoPrompt', () => {
  test('tells root Neo to open, file under and settle asks', () => {
    const prompt = neoPrompt(null);
    expect(prompt).toContain('record it with neo.ask.open before proposing its work');
    expect(prompt).toContain('Propose every card for that request with its askId');
    expect(prompt).toContain('neo.ask.settle {id,outcome,evidence}');
    expect(neoPrompt('book-club')).toContain('File work only under asks you opened yourself');
    expect(prompt).toContain('save it straight away with neo.rule.save');
    expect(prompt).toContain('Never ask whether to save it.');
    expect(neoPrompt('book-club')).not.toContain('neo.rule.save as a rule');
  });
});

describe('driverDoneCheckNote', () => {
  const goal = { workId: 'w', goal: 'Fix it', doneWhen: '- merged' };
  const work = { id: 'w', title: 'Fix it', report: 'Merged.', originSessionId: 'root' };

  test('asks the session that opened the ask to settle it, and only that session', () => {
    expect(driverDoneCheckNote(work, goal, 0, null, { ask })).toContain(
      'settle it with neo.ask.settle'
    );
    const other = driverDoneCheckNote({ ...work, originSessionId: 'holder' }, goal, 0, null, {
      ask,
    });
    expect(other).toContain('do not settle the ask');
    expect(other).not.toContain('settle it with neo.ask.settle');
  });
});

describe('planNeoCardAsk', () => {
  const origin = { originSessionId: 'root', originMessageId: 'm1' };
  const card = { requestKey: 'k', concernId: null, title: 'Fix it', doneWhen: '- merged' };

  test('plans an ask only for a card with a done list and no ask', () => {
    expect(planNeoCardAsk({ ...card, askId: 'a1' }, origin)).toBe(null);
    expect(planNeoCardAsk({ ...card, doneWhen: undefined }, origin)).toBe(null);
    expect(planNeoCardAsk(card, origin)).toEqual({
      requestKey: 'card:root:k',
      concernId: null,
      originSessionId: 'root',
      originMessageId: 'm1',
      title: 'Fix it',
      ask: 'Fix it',
      doneWhen: '- merged',
      doneSource: 'card',
    });
    expect(planNeoCardAsk({ ...card, goal: 'Their words' }, origin)?.ask).toBe('Their words');
  });
});

describe('isNeoCardAsk', () => {
  test('accepts only the ask the card planned, never one that shares its key', () => {
    const planned = planNeoCardAsk(
      { requestKey: 'k', concernId: null, title: 'Fix it', doneWhen: '- merged' },
      { originSessionId: 'root', originMessageId: 'm1' }
    )!;
    const opened = { ...ask, ...planned };
    expect(isNeoCardAsk(opened, planned)).toBe(true);
    expect(isNeoCardAsk({ ...opened, doneWhen: '- deployed' }, planned)).toBe(false);
    expect(isNeoCardAsk(null, planned)).toBe(false);
  });
});

describe('neoPrompt reply length', () => {
  test('keeps shortText to the outcome and the next action', () => {
    expect(neoPrompt(null)).toContain(
      'shortText is one or two short sentences: the outcome for what they asked'
    );
  });
});
