import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import {
  projectNeoSnapshotAsks,
  requireNeoAskConcern,
  isNeoAskReplay,
  planNeoAskItems,
  planNeoAskEdit,
  planNeoAskTickStatus,
  requireNeoAskEdit,
  planNeoAskWorkStops,
  planNeoCardAsk,
  isNeoCardAsk,
  requireNeoAskReceipt,
  requireNeoAskSettlement,
  requireNeoAskSummary,
  requireNeoAskWritten,
  requireNeoAskLive,
  requireNeoAskOwner,
  requireNeoWorkAsk,
  requireNeoWorkAskLink,
} from '../../../../src/lib/neo/ask-operations.ts';
import {
  driverDoneCheckNote,
  driverNeedsYouNote,
  neoWorkDoneGoal,
  projectNeoAskCards,
} from '../../../../src/lib/neo/driver-work.ts';
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

  test('stores the done list as checklist items and shows them in the snapshot', async () => {
    const opened = await invoke('neo.ask.open', {
      ...opening,
      requestKey: 'checklist',
      doneWhen: undefined,
      doneItems: [
        { text: 'Fix merged to dev', check: 'coding.pr_merged' },
        { text: 'Docs updated' },
      ],
    });
    const item = (id: string, text: string, check: 'coding.pr_merged' | null) => ({
      id,
      text,
      state: 'pending',
      evidence: null,
      check,
      metBy: null,
      removed: false,
      addedAt: null,
    });
    expect(opened).toMatchObject({
      value: {
        ok: true,
        ask: {
          doneWhen: '- Fix merged to dev\n- Docs updated',
          doneItems: [
            item('i1', 'Fix merged to dev', 'coding.pr_merged'),
            item('i2', 'Docs updated', null),
          ],
        },
      },
    });
    expect(
      await invoke('neo.ask.open', {
        ...opening,
        requestKey: 'checklist',
        doneWhen: undefined,
        doneItems: [
          { text: 'Fix merged to dev', check: 'coding.pr_merged' },
          { text: 'Docs updated' },
        ],
      })
    ).toMatchObject({ value: { ok: true, ask: { id: opened.value!.ask!.id } } });
    const asks = (await invoke('neo.snapshot', {})).value?.asks as NeoAsk[];
    expect(asks.find((ask) => ask.id === opened.value!.ask!.id)?.doneItems).toHaveLength(2);

    const legacy = await invoke('neo.ask.open', opening);
    expect(legacy.value!.ask!.doneItems?.map((done) => done.text)).toEqual([
      'merged to dev',
      'CI green',
    ]);
    expect(
      await invoke('neo.ask.open', { ...opening, requestKey: 'none', doneWhen: undefined })
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });

  test('opens an ask under an enabled pack and briefs it in the same value', async () => {
    const opened = await invoke('neo.ask.open', { ...opening, pack: 'coding' });
    expect(opened).toMatchObject({
      value: { ok: true, ask: { id: opened.value!.ask!.id, pack: 'coding' } },
    });
    expect((opened.value as { packBriefing?: string }).packBriefing).toBe(
      NEO_PACK_CODING_INSTRUCTIONS
    );

    const replay = await invoke('neo.ask.open', { ...opening, pack: 'coding' });
    expect(replay).toMatchObject({
      value: { ok: true, ask: { id: opened.value!.ask!.id, pack: 'coding' } },
    });
    expect(await invoke('neo.ask.open', { ...opening, pack: 'legal-review' })).toMatchObject({
      value: {
        ok: false,
        reason: expect.stringContaining('pack_not_enabled: "legal-review"'),
      },
    });
    expect(await invoke('neo.ask.open', opening)).toMatchObject({
      value: { ok: false, reason: 'This request key already belongs to another ask.' },
    });

    const asks = (await invoke('neo.snapshot', {})).value?.asks as NeoAsk[];
    expect(asks.find((ask) => ask.id === opened.value!.ask!.id)?.pack).toBe('coding');
  });

  test('reads an installed pack through neo.pack.read and refuses unknown ids', async () => {
    const read = await invoke('neo.pack.read', { id: 'coding' });
    expect(read).toMatchObject({
      value: {
        ok: true,
        pack: {
          id: 'coding',
          describe: 'Software work in git repositories: pull requests, CI, review and merging.',
        },
        instructions: NEO_PACK_CODING_INSTRUCTIONS,
      },
    });
    expect(await invoke('neo.pack.read', { id: 'legal-review' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('pack_not_found') },
    });
  });

  test('the enable setting gates the packs an ask may name', async () => {
    db.updateGlobalSettings({ neo: { packs: [] } });
    expect(await invoke('neo.ask.open', { ...opening, pack: 'coding' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('pack_not_enabled: "coding"') },
    });
    expect(await invoke('neo.ask.open', opening)).toMatchObject({
      value: { ok: true, ask: { id: expect.any(String), pack: null } },
    });
    expect(service.packBriefs()).toEqual([]);
  });

  test('an enabled file pack joins the registry, the ask door and the prompt', async () => {
    service.filePacks = [
      { id: 'life-admin', describe: 'Life admin', instructions: () => 'File the inbox daily.' },
    ];
    db.updateGlobalSettings({ neo: { packs: ['coding', 'life-admin'] } });
    const opened = await invoke('neo.ask.open', { ...opening, pack: 'life-admin' });
    expect(opened).toMatchObject({ value: { ok: true, ask: { pack: 'life-admin' } } });
    expect((opened.value as { packBriefing?: string }).packBriefing).toBe('File the inbox daily.');
    expect(await invoke('neo.pack.read', { id: 'life-admin' })).toMatchObject({
      value: { ok: true, instructions: 'File the inbox daily.' },
    });
    expect(neoPrompt(null, service.packBriefs())).toContain('life-admin — Life admin');
    db.updateGlobalSettings({ neo: { packs: ['coding'] } });
    expect(service.packBriefs().map((brief) => brief.id)).toEqual(['coding']);
  });

  test('refuses work under a missing or achieved ask, and settling is final', async () => {
    const askId = await openAsk();
    expect(await propose('card-1', 'nope')).toMatchObject({
      value: { ok: false, reason: 'ask_not_found' },
    });

    const settle = {
      id: askId,
      outcome: 'achieved',
      summary: 'Merged in #12.',
      evidence: 'PR #12 merged, CI green.',
    };
    expect(await invoke('neo.ask.settle', { ...settle, summary: undefined })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('summary_required') },
    });
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({
      value: {
        ok: false,
        reason: expect.stringContaining('checklist_incomplete: i1 "merged to dev"'),
      },
    });
    for (const itemId of ['i1', 'i2'])
      await invoke('neo.ask.tick', {
        askId,
        itemId,
        state: 'met',
        evidence: 'PR #12 merged, CI green.',
      });
    expect(await invoke('neo.ask.settle', settle)).toMatchObject({
      value: {
        ok: true,
        ask: { status: 'achieved', outcome: 'Merged in #12.', evidence: settle.evidence },
      },
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
    await invoke('neo.ask.settle', {
      id: askId,
      outcome: 'blocked',
      summary: 'Needs you: which API?',
      evidence: 'Two APIs fit.',
    });

    await propose('card-1', askId);

    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open', settledAt: null });
  });

  test('ticks checklist items, and an item that needs the human makes the ask wait on it', async () => {
    const askId = await openAsk();
    expect(await invoke('neo.ask.tick', { askId, itemId: 'i1', state: 'met' })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('evidence_required') },
    });
    expect(
      await invoke('neo.ask.tick', { askId, itemId: 'i9', state: 'met', evidence: 'x' })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('item_not_found') } });
    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i1',
        state: 'met',
        evidence: 'PR #12 merged.',
      })
    ).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'open',
          doneItems: [
            expect.objectContaining({
              id: 'i1',
              state: 'met',
              metBy: 'neo',
              evidence: 'PR #12 merged.',
            }),
            expect.objectContaining({ id: 'i2', state: 'pending', metBy: null }),
          ],
        },
      },
    });

    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i2',
        state: 'needs_you',
        evidence: 'Is red CI on main acceptable?',
      })
    ).toMatchObject({ value: { ok: true, ask: { status: 'waiting', outcome: 'CI green' } } });
    expect(
      await invoke(
        'neo.ask.tick',
        { askId, itemId: 'i2', state: 'met', evidence: 'The human said yes.' },
        { source: 'rpc', principal: 'local' }
      )
    ).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'open',
          doneItems: [expect.anything(), expect.objectContaining({ metBy: 'human' })],
        },
      },
    });
    expect(
      await invoke(
        'neo.ask.tick',
        { askId, itemId: 'i1', state: 'pending' },
        { ...neo, sessionId: 'other' }
      )
    ).toMatchObject({ value: { ok: false } });
  });

  test('the user can close an ask as done even with items still open', async () => {
    const askId = await openAsk();
    expect(
      await invoke(
        'neo.ask.settle',
        { id: askId, outcome: 'achieved', evidence: 'Closed by the user.' },
        { source: 'rpc', principal: 'local' }
      )
    ).toMatchObject({ value: { ok: true, ask: { status: 'achieved' } } });
  });

  test('an offer waits on the human, and starting its work item reopens the ask', async () => {
    const askId = await openAsk();
    const offered = (await propose('card-1', askId)).value!.work!.id;
    expect(
      await invoke('neo.ask.settle', {
        id: askId,
        outcome: 'waiting',
        summary: 'Start the login fix?',
        evidence: 'Offered a work item; nothing started.',
      })
    ).toMatchObject({
      value: { ok: true, ask: { status: 'waiting', outcome: 'Start the login fix?' } },
    });
    expect(service.repo.getWork(offered)?.status).toBe('proposed');
    expect((await invoke('neo.snapshot', {})).value?.asks).toEqual([
      expect.objectContaining({ id: askId, status: 'waiting' }),
    ]);

    await service.start(offered).catch(() => {});
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
        { id: askId, outcome: 'abandoned', summary: 'Dropped.', evidence: 'x' },
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
    ).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'abandoned',
          outcome: 'Closed by the user.',
          evidence: 'Closed by the user.',
        },
      },
    });
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

  test('edits the checklist in view: removed items stay listed, and dropping a question reopens the ask', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.tick', {
      askId,
      itemId: 'i2',
      state: 'needs_you',
      evidence: 'Is red CI on main acceptable?',
    });
    expect(
      await invoke('neo.ask.edit', { askId, remove: ['i2'], add: [{ text: 'Release notes' }] })
    ).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'open',
          doneItems: [
            expect.objectContaining({ id: 'i1', removed: false }),
            expect.objectContaining({ id: 'i2', text: 'CI green', removed: true }),
            expect.objectContaining({
              id: 'i3',
              text: 'Release notes',
              state: 'pending',
              removed: false,
              addedAt: expect.any(Number),
            }),
          ],
        },
      },
    });
    expect(await invoke('neo.ask.edit', { askId, remove: ['i2'] })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('item_not_found: i2') },
    });
    expect(
      await invoke('neo.ask.edit', { askId, add: [{ text: 'x' }] }, { ...neo, sessionId: 'other' })
    ).toMatchObject({ value: { ok: false } });
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

describe('requireNeoAskOwner', () => {
  test('lets the opening Neo session and the user act, and refuses other sessions', () => {
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    expect(requireNeoAskOwner(ask, neo, 'tick')).toEqual({ value: ask });
    expect(requireNeoAskOwner(ask, user, 'tick')).toEqual({ value: ask });
    expect(requireNeoAskOwner(ask, { ...neo, sessionId: 'holder' }, 'tick')).toEqual({
      reason: {
        ok: false,
        reason: 'Only the Neo session that opened this ask or the user can tick it.',
      },
    });
    expect(requireNeoAskOwner(null, neo, 'tick')).toEqual({
      reason: { ok: false, reason: 'ask_not_found' },
    });
  });
});

describe('requireNeoAskLive', () => {
  test('refuses a settled ask with its status', () => {
    expect(requireNeoAskLive({ ...ask, status: 'waiting' })).toMatchObject({ value: {} });
    expect(requireNeoAskLive({ ...ask, status: 'abandoned' }, '; open a new ask')).toEqual({
      reason: { ok: false, reason: 'ask_settled: this ask is already abandoned; open a new ask.' },
    });
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
describe('requireNeoAskSummary', () => {
  const settle = { id: 'a1', outcome: 'achieved' as const, evidence: 'PR #12 merged, CI green.' };
  test.each<[string, typeof settle & { summary?: string }, OperationCaller, boolean]>([
    ['Neo with a summary', { ...settle, summary: 'Merged in #12.' }, neo, true],
    ['Neo without one', settle, neo, false],
    ["the user's close button without one", settle, { source: 'rpc', principal: 'local' }, true],
  ])('%s', (_case, input, caller, admitted) => {
    expect('value' in requireNeoAskSummary(input, caller)).toBe(admitted);
  });
});

describe('isNeoAskReplay', () => {
  const settle = {
    id: 'a1',
    outcome: 'achieved' as const,
    summary: 'Merged in #12.',
    evidence: 'PR #12 merged.',
  };
  const done = { ...ask, status: 'achieved' as const, outcome: 'Merged in #12.' };
  test.each<[string, NeoAsk, boolean]>([
    ['the same summary and evidence', { ...done, evidence: 'PR #12 merged.' }, true],
    ['other evidence', { ...done, evidence: 'PR #13 merged.' }, false],
    ['another summary', { ...done, outcome: 'Done.', evidence: 'PR #12 merged.' }, false],
    ['another status', { ...done, status: 'abandoned', evidence: 'PR #12 merged.' }, false],
  ])('%s', (_case, current, replay) => {
    expect(isNeoAskReplay(current, settle)).toBe(replay);
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

describe('planNeoAskItems', () => {
  const free = 'Merged to dev after CI and bot approval.';
  test.each<[string, Parameters<typeof planNeoAskItems>[0], ReturnType<typeof planNeoAskItems>]>([
    [
      'a checklist',
      {
        doneItems: [
          { text: 'Merged', check: 'coding.pr_merged' },
          { text: 'Docs', check: null },
        ],
      },
      {
        doneWhen: '- Merged\n- Docs',
        items: [
          { text: 'Merged', check: 'coding.pr_merged' },
          { text: 'Docs', check: null },
        ],
      },
    ],
    [
      'a bulleted done list under a heading',
      { doneWhen: 'Done when:\n- merged\n* docs\n2) released' },
      {
        doneWhen: 'Done when:\n- merged\n* docs\n2) released',
        items: ['merged', 'docs', 'released'].map((text) => ({ text, check: null })),
      },
    ],
    ['free text', { doneWhen: free }, { doneWhen: free, items: [{ text: free, check: null }] }],
  ])('%s', (_label, input, plan) => {
    expect(planNeoAskItems(input)).toEqual(plan);
  });
});

describe('requireNeoAskEdit', () => {
  const owned = {
    ...ask,
    originSessionId: 'root',
    doneItems: [
      { id: 'i1', removed: false },
      { id: 'i2', removed: true },
    ],
  } as unknown as NeoAsk;
  const items = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ text: `t${i}`, check: null }));
  test.each<
    [
      string,
      Partial<NeoAsk> | null,
      { add?: ReturnType<typeof items>; remove?: string[] },
      string | null,
    ]
  >([
    ['an edit by the owner', {}, { add: items(1) }, null],
    ['a missing ask', null, { add: items(1) }, 'ask_not_found'],
    ['a settled ask', { status: 'achieved' }, { add: items(1) }, 'ask_settled'],
    ['an item already removed', {}, { remove: ['i2'] }, 'item_not_found'],
    ['removing the last item', {}, { remove: ['i1'] }, 'checklist_empty'],
    ['more than twelve items', {}, { add: items(12) }, 'checklist_full'],
  ])('%s', (_label, overrides, change, reason) => {
    const target = overrides ? { ...owned, ...overrides } : null;
    const gate = requireNeoAskEdit(
      { askId: 'a1', add: change.add ?? [], remove: change.remove ?? [] },
      { ask: target },
      neo
    );
    const expected: unknown = reason
      ? { reason: { ok: false, reason: expect.stringContaining(reason) } }
      : { value: target };
    expect(gate as unknown).toEqual(expected);
  });
});

describe('planNeoAskEdit', () => {
  test('numbers added items past every earlier one, removed ones included', () => {
    const edited = {
      ...ask,
      doneItems: [
        { id: 'i1', removed: false },
        { id: 'i2', removed: true },
      ],
    } as unknown as NeoAsk;
    expect(
      planNeoAskEdit(edited, {
        askId: 'a1',
        add: [{ text: 'Docs', check: null }],
        remove: ['i1', 'i1'],
      })
    ).toEqual({ add: [{ text: 'Docs', check: null, id: 'i3', position: 2 }], remove: ['i1'] });
  });
});

describe('planNeoAskTickStatus', () => {
  const item = (id: string, state: 'pending' | 'met' | 'needs_you', removed = false) => ({
    id,
    text: `Item ${id}`,
    state,
    evidence: null,
    check: null,
    metBy: null,
    removed,
    addedAt: null,
  });
  test.each<[string, Partial<NeoAsk>, ReturnType<typeof planNeoAskTickStatus>]>([
    [
      'an item that needs the human',
      { doneItems: [item('i1', 'needs_you')] },
      { status: 'waiting', outcome: 'Item i1', item: 'i1' },
    ],
    [
      'the same question already asked',
      {
        status: 'waiting',
        outcome: 'Item i1',
        waitingItem: 'i1',
        doneItems: [item('i1', 'needs_you')],
      },
      { status: 'unchanged' },
    ],
    [
      'the last question answered',
      {
        status: 'waiting',
        outcome: 'Item i1',
        waitingItem: 'i1',
        doneItems: [item('i1', 'met')],
      },
      { status: 'open' },
    ],
    [
      'a deliberate wait whose summary happens to match an item',
      { status: 'waiting', outcome: 'Item i1', waitingItem: null, doneItems: [item('i1', 'met')] },
      { status: 'unchanged' },
    ],
    [
      'an offer that waits for another reason',
      { status: 'waiting', outcome: 'Start it?', doneItems: [item('i1', 'met')] },
      { status: 'unchanged' },
    ],
    [
      'a removed item that needed the human',
      { doneItems: [item('i1', 'needs_you', true)] },
      { status: 'unchanged' },
    ],
    [
      'a question whose item was removed',
      {
        status: 'waiting',
        outcome: 'Item i1',
        waitingItem: 'i1',
        doneItems: [item('i1', 'needs_you', true)],
      },
      { status: 'open' },
    ],
    [
      'a settled ask',
      { status: 'achieved', doneItems: [item('i1', 'needs_you')] },
      { status: 'unchanged' },
    ],
  ])('%s', (_label, overrides, plan) => {
    expect(planNeoAskTickStatus({ ...ask, ...overrides })).toEqual(plan);
  });
});

describe('planNeoAskWorkStops', () => {
  const works = [
    { id: 'q', status: 'queued' as const },
    { id: 'p', status: 'proposed' as const },
    { id: 'r', status: 'reported' as const },
  ];

  test.each<
    [string, Parameters<typeof planNeoAskWorkStops>[1], ReturnType<typeof planNeoAskWorkStops>]
  >([
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
    ['waiting leaves the offered work for the human to start', 'waiting', []],
  ])('%s', (_case, outcome, stops) => {
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
    expect(prompt).toContain('Propose every work item for that request with its askId');
    expect(prompt).toContain('neo.ask.settle {id,outcome,summary,evidence}');
    expect(prompt).toContain('the proof goes in evidence, never in summary');
    expect(prompt).toContain('Never offer work only in text');
    expect(prompt).toContain('settle waiting with summary naming them, never achieved');
    expect(prompt).toContain('neo.snapshot returns waitingOnHuman');
    expect(neoPrompt('book-club')).toContain('File work only under asks you opened yourself');
    expect(prompt).toContain('save it straight away with neo.rule.save');
    expect(prompt).toContain('Never ask whether to save it.');
    expect(prompt).toContain('or from precedent: what done meant for the same kind of work');
    expect(prompt).toContain('corrects you with something lasting');
    expect(neoPrompt('book-club')).not.toContain('neo.rule.save as a rule');
  });

  test('carries the enabled packs and keeps the core prompt free of coding examples', () => {
    const prompt = neoPrompt(null);
    expect(prompt).toContain('coding — Software work in git repositories');
    expect(prompt).toContain('pass its id as pack to neo.ask.open');
    expect(prompt).toContain('neo.pack.read {id}');
    for (const gone of [
      'for code usually merged, not a pull request opened',
      'Merged in #6099.',
      'a git remote that matches the repository the human named',
      'let the app make its own worktree',
      'HyperNeo code is done when merged to dev',
      'Fix merged to dev',
    ]) {
      expect(prompt).not.toContain(gone);
    }
    expect(prompt).toContain('The fix is live');
    expect(neoPrompt(null, [])).not.toContain('Domain packs');
  });
});

describe('driverDoneCheckNote', () => {
  const goal = { workId: 'w', goal: 'Fix it', doneWhen: '- merged' };
  const work = { id: 'w', title: 'Fix it', report: 'Merged.', originSessionId: 'root' };

  const sibling = { id: 'w2', title: 'Ship the docs', status: 'queued' as const };

  test('asks the session that opened the ask to settle it, and only that session', () => {
    const owned = driverDoneCheckNote(work, goal, 0, null, { ask, cards: [sibling] });
    expect(owned).toContain('Otherwise settle the ask: neo.ask.settle');
    expect(owned).toContain('end the turn without telling the human');
    expect(JSON.parse(owned.slice(owned.indexOf('\n{'))).ask.cards).toEqual([sibling]);
    const other = driverDoneCheckNote({ ...work, originSessionId: 'holder' }, goal, 0, null, {
      ask,
      cards: [sibling],
    });
    expect(other).toContain('do not settle the ask');
    expect(other).not.toContain('settle the ask: neo.ask.settle');
    expect(JSON.parse(other.slice(other.indexOf('\n{'))).ask.cards).toBeUndefined();
  });

  test('tells the owner to settle before telling the human, also once the budget is spent', () => {
    const spent = driverDoneCheckNote(work, goal, 5, 'continue_budget_spent', { ask });
    expect(spent).toContain('Do not continue it. First tick what this report proves on ask.items');
    expect(spent.indexOf('settle the ask')).toBeLessThan(spent.indexOf('Read the whole report'));
  });

  test('embeds the ask pack guidance in a delivered note', () => {
    const noted = driverDoneCheckNote(work, goal, 0, null, {
      ask: { ...ask, pack: 'coding' },
      pack: { id: 'coding', instructions: NEO_PACK_CODING_INSTRUCTIONS },
    });
    expect(noted).toContain(`Guidance from the coding pack, which this ask works under:`);
    expect(noted).toContain(NEO_PACK_CODING_INSTRUCTIONS);
    expect(driverDoneCheckNote(work, goal, 0, null, { ask, pack: null })).not.toContain(
      'which this ask works under'
    );
  });
});

describe('projectNeoAskCards', () => {
  const pr = {
    url: 'https://github.com/lsm/HyperNeo/pull/7',
    state: 'OPEN' as const,
    checks: 'pending' as const,
    review: 'none' as const,
  };
  const card = (id: string) => ({ id, title: `Card ${id}`, status: 'reported' as const });
  test.each<[string, Parameters<typeof projectNeoAskCards>, ReturnType<typeof projectNeoAskCards>]>(
    [
      ['only the card itself', ['w1', [card('w1')], []], []],
      [
        'a sibling with a pull request',
        ['w1', [card('w1'), card('w2')], [{ workId: 'w2', prs: [pr] }]],
        [{ ...card('w2'), prs: [pr] }],
      ],
      [
        'more siblings than fit',
        ['w0', Array.from({ length: 12 }, (_, i) => card(`w${i}`)), []],
        Array.from({ length: 10 }, (_, i) => card(`w${i + 2}`)),
      ],
    ]
  )('%s', (_label, args, cards) => {
    expect(projectNeoAskCards(...args)).toEqual(cards);
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

describe('neoPrompt decision items', () => {
  test('tells Neo to give a decision its own item instead of an outcome item', () => {
    expect(neoPrompt(null)).toContain('never tick an outcome item needs_you for a decision');
  });
});

describe('driverNeedsYouNote', () => {
  test('asks Neo to record the decision as its own item before telling the human', () => {
    expect(
      driverNeedsYouNote(
        { id: 'w1', title: 'Fix startup' },
        { adapter: 'claude-desktop', daemon: 'laptop', id: 't1' },
        'A or B?'
      )
    ).toContain('record it first as its own checklist item with neo.ask.edit');
  });
});

describe('neoPrompt dropped items', () => {
  test('tells Neo to remove an item the human dropped instead of ticking it met', () => {
    expect(neoPrompt(null)).toContain(
      'when the human drops part of an ask, remove that item (it stays listed as removed), and never tick a dropped item met'
    );
  });
});

describe('neoPrompt stale failures', () => {
  test('tells Neo to re-check an old failure before repeating it', () => {
    expect(neoPrompt(null)).toContain(
      'before you tell the human something is still broken, or skip or refuse work because of it, check it again now'
    );
  });
});

describe('neoPrompt reply length', () => {
  test('keeps shortText to the outcome and the next action', () => {
    expect(neoPrompt(null)).toContain(
      'shortText is one or two short sentences: the outcome for what they asked'
    );
  });
});

describe('neoPrompt place resolution', () => {
  test('tells Neo to find the place with work.find and never guess a folder', () => {
    for (const prompt of [neoPrompt(null), neoPrompt('book-club')]) {
      expect(prompt).toContain('call work.find with the project words from the request');
      expect(prompt).toContain('Never build or guess a folder path yourself.');
      expect(prompt).toContain('using an adapter that can start work');
    }
  });
});
