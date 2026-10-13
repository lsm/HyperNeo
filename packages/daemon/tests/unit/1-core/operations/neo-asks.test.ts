import { z } from 'zod';
import { adoptNeoFilePacks } from '../../../../src/lib/neo/packs/index.ts';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  isPooledNeoAsk,
  NEO_ASK_CONTINUE_WINDOW_MS,
  type NeoAsk,
  neoAskApprovalSpent,
  type NeoSnapshot,
} from '@hyperneo/shared/types/neo-snapshot';
import {
  projectNeoSnapshotAsks,
  requireNeoAskConcern,
  isNeoAskReplay,
  planNeoAskItems,
  planNeoAskEdit,
  planNeoAskTickStatus,
  neoAsksForApproval,
  requireNeoAskApprovalLapsed,
  requireNeoAskItemKind,
  isNeoAskHandedOver,
  requireNeoAskEdit,
  planNeoAskWorkStops,
  planNeoCardAsk,
  isNeoCardAsk,
  requireNeoAskReceipt,
  requireNeoAskSettleable,
  requireNeoAskSummary,
  requireNeoAskWritten,
  requireNeoAskLive,
  requireNeoAskOwner,
  requireNeoOwnedLiveAsk,
  requireNeoWorkAsk,
  requireNeoWorkAskLive,
  requireNeoWorkAskOwner,
  requireNeoWorkAskLink,
  neoAskTitleNamedIn,
} from '../../../../src/lib/neo/ask-operations.ts';
import {
  driverDoneCheckNote,
  driverNeedsYouNote,
  neoWorkDoneGoal,
  projectNeoAskCards,
} from '../../../../src/lib/neo/driver-work.ts';
import { isNeoAskStartApproved } from '../../../../src/lib/neo/work-origin.ts';
import {
  createNeoOperations,
  isNeoTurnAskReadable,
  neoAskScope,
} from '../../../../src/lib/neo/operations.ts';
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
const nextMessage: OperationCaller = { ...neo, neoTurn: { ...neo.neoTurn!, messageId: 'ask-2' } };
const place = { machine: 'laptop', folder: tmpdir(), name: 'app' };
const rule = 'Ask me before accepting red CI or a release date.';
const opening = {
  requestKey: 'fix',
  title: 'Fix the login bug',
  ask: 'Fix the login bug and get it merged',
  doneWhen: '- implementation ready\n- CI green',
  doneSource: 'human',
};

describe('isNeoTurnAskReadable', () => {
  test('root reads any turn ask, a holder only its own concern, anyone else none', () => {
    expect(isNeoTurnAskReadable({ kind: 'neo', concernId: null }, { concernId: 'club' })).toBe(
      true
    );
    expect(
      isNeoTurnAskReadable({ kind: 'concern', concernId: 'club' }, { concernId: 'club' })
    ).toBe(true);
    expect(isNeoTurnAskReadable({ kind: 'concern', concernId: 'club' }, { concernId: null })).toBe(
      false
    );
    expect(
      isNeoTurnAskReadable({ kind: 'concern', concernId: 'club' }, { concernId: 'work' })
    ).toBe(false);
    expect(isNeoTurnAskReadable({ kind: 'worker', concernId: 'club' }, { concernId: 'club' })).toBe(
      false
    );
    expect(isNeoTurnAskReadable(null, { concernId: null })).toBe(false);
  });
});

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
    db.updateGlobalSettings({ neo: { standingRules: [rule] } });
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

  test('an ask opened in a turn the human sent is approved, so its cards start without Start', async () => {
    const askId = await openAsk();
    expect(service.askRecords.get(askId)?.approvedAt).toEqual(expect.any(Number));
    const card = service.repo.getWork((await propose('card-1', askId)).value!.work!.id)!;
    const later: OperationCaller = {
      ...neo,
      neoTurn: { ...neo.neoTurn!, messageId: 'later', human: false },
    };
    expect(isNeoAskStartApproved(card, service.askRecords.get(askId), later)).toBe(true);
  });

  test('only a human message opens an ask; a note turn is told to edit the ask it works on', async () => {
    const note: OperationCaller = { ...neo, neoTurn: { ...neo.neoTurn!, human: false } };
    expect(await invoke('neo.ask.open', { ...opening, requestKey: 'quiet' }, note)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('Only a human message opens an ask') },
    });
    expect(await invoke('neo.ask.open', opening)).toMatchObject({ value: { ok: true } });
    expect(isNeoAskHandedOver({ source: 'rpc', principal: 'local' })).toBe(false);
  });

  test('a human message naming an open ask, its title, its card or its PR edits that ask instead', async () => {
    const say = (uuid: string, content: string) =>
      db.getSDKMessageRepo().saveSDKMessage('root', {
        type: 'user',
        uuid,
        session_id: 'root',
        parent_tool_use_id: null,
        inputKind: 'human',
        message: { role: 'user', content },
      } as unknown as SDKUserMessage);
    const askId = await openAsk();
    const card = (await propose('card-1', askId)).value!.work!.id;
    service.workPrs.record(
      card,
      [
        {
          url: 'https://github.com/lsm/HyperNeo/pull/6670',
          state: 'OPEN',
          checks: 'pending',
          review: 'none',
        },
      ],
      Date.now()
    );
    const openFrom = (uuid: string) =>
      invoke(
        'neo.ask.open',
        { ...opening, requestKey: uuid },
        { ...neo, neoTurn: { ...neo.neoTurn!, messageId: uuid } }
      );
    for (const [uuid, said] of [
      ['m-ask', `Also make ${askId.slice(0, 8)} cover the signup page.`],
      ['m-card', `Card ${card.slice(0, 10).toUpperCase()} should rebase first.`],
      ['m-pr', 'Address the review on lsm/HyperNeo#6670.'],
      ['m-title-quoted', '`Fix the login bug` 这个你让codex看一下 neo-ios 怎么实现的'],
      ['m-title', 'For Fix the login bug, also check Safari.'],
    ]) {
      say(uuid, said);
      expect(await openFrom(uuid)).toMatchObject({
        value: {
          ok: false,
          reason: `This message is about ask ${askId} (Fix the login bug); change it with neo.ask.edit instead of opening a new ask.`,
        },
      });
    }
    say('m-near', 'Fix the login page styling too.');
    expect(await openFrom('m-near')).toMatchObject({ value: { ok: true } });
    say('m-new', 'Separately, write release notes for #6671 and the 0.44 tag.');
    expect(await openFrom('m-new')).toMatchObject({ value: { ok: true } });
  });

  test('a local user opens an ask whatever the message names', async () => {
    const askId = await openAsk();
    expect(
      await invoke(
        'neo.ask.open',
        { ...opening, requestKey: 'local', ask: `Same as ${askId}` },
        { source: 'rpc', principal: 'local', sessionId: 'root' }
      )
    ).toMatchObject({ value: { ok: true } });
  });

  test("a note leaves out an enabled pack's guidance, which the system prompt carries", () => {
    const filePack = {
      id: 'inbox-triage',
      describe: 'Inbox triage',
      instructions: () => 'Triage the inbox.',
    };
    service.filePacks = adoptNeoFilePacks([filePack]);
    db.updateGlobalSettings({ neo: { packs: ['coding', 'inbox-triage'] } });
    try {
      for (const id of ['coding', 'inbox-triage'])
        expect(service.askPackFragment({ pack: id } as NeoAsk)?.inPrompt).toBe(true);
      db.updateGlobalSettings({ neo: { packs: ['coding'] } });
      expect(service.askPackFragment({ pack: 'inbox-triage' } as NeoAsk)).toMatchObject({
        instructions: 'Triage the inbox.',
        inPrompt: false,
      });
    } finally {
      adoptNeoFilePacks([]);
    }
  });

  test('a snapshot in an ask turn reads that ask, and answers unchanged when nothing moved', async () => {
    db.getSDKMessageRepo().saveSDKMessage('root', {
      type: 'user',
      uuid: 'ask-1',
      session_id: 'root',
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Fix the login bug and get it merged.' },
    } as unknown as SDKUserMessage);
    const askId = await openAsk();
    await invoke(
      'neo.ask.open',
      { ...opening, requestKey: 'other', title: 'Other' },
      {
        ...neo,
        neoTurn: { ...neo.neoTurn!, messageId: 'ask-2' },
      }
    );
    const scoped = (await invoke('neo.snapshot', {})).value as unknown as NeoSnapshot;
    expect(scoped.scopedTo).toBe(askId);
    expect(scoped.asks?.map((ask) => ask.id)).toEqual([askId]);
    expect(
      ((await invoke('neo.snapshot', { all: true })).value as unknown as NeoSnapshot).asks
    ).toHaveLength(2);
    expect(await invoke('neo.snapshot', { sinceRev: scoped.rev })).toMatchObject({
      value: { ok: true, unchanged: true, rev: scoped.rev, scopedTo: askId },
    });
    await invoke('neo.ask.tick', { askId, itemId: 'i1', state: 'met', evidence: 'PR #12 merged.' });
    const moved = (await invoke('neo.snapshot', { sinceRev: scoped.rev }))
      .value as unknown as NeoSnapshot;
    expect(moved.rev).not.toBe(scoped.rev);
    expect(moved.asks).toHaveLength(1);
  });

  test('a repeated read answers unchanged without sinceRev, and in full again after a compaction', async () => {
    const first = (await invoke('neo.snapshot', {})).value as unknown as NeoSnapshot;
    expect(first.rev).toBeTruthy();
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { ok: true, unchanged: true, rev: first.rev },
    });
    expect(
      ((await invoke('neo.snapshot', { all: true })).value as { unchanged?: true }).unchanged
    ).toBeUndefined();
    expect(
      (
        (await invoke('neo.snapshot', {}, { source: 'rpc', principal: 'local' })).value as {
          unchanged?: true;
        }
      ).unchanged
    ).toBeUndefined();

    db.getSDKMessageRepo().saveSDKMessage('root', {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compacted',
      session_id: 'root',
      compact_metadata: { trigger: 'auto', pre_tokens: 1 },
    } as unknown as SDKUserMessage);
    const reread = (await invoke('neo.snapshot', {})).value as unknown as NeoSnapshot;
    expect(reread).toMatchObject({ rev: first.rev });
    expect((reread as { unchanged?: true }).unchanged).toBeUndefined();
    expect(await invoke('neo.snapshot', {})).toMatchObject({ value: { unchanged: true } });
  });

  test('a work operation answers with its ask, so Neo needs no follow-up read', async () => {
    const askId = await openAsk();
    const proposed = await propose('card-1', askId);
    const card = proposed.value!.work!.id;
    expect(proposed).toMatchObject({
      value: {
        ok: true,
        ask: {
          id: askId,
          status: 'open',
          items: [
            { id: 'i1', state: 'pending', text: 'implementation ready' },
            { id: 'i2', state: 'pending', text: 'CI green' },
          ],
          cards: [{ id: card, title: 'Fix it', status: 'proposed' }],
        },
      },
    });
    expect(await invoke('neo.work.cancel', { id: card })).toMatchObject({
      value: { ok: true, ask: { id: askId, cards: [{ id: card, status: 'cancelled' }] } },
    });
  });

  test('an ask operation answers with the derived view, its human actions included', async () => {
    const askId = await openAsk();
    const card = (await propose('card-1', askId)).value!.work!.id;
    const asked = await invoke('neo.ask.question', {
      askId,
      question: 'Own data dir or attach?',
      options: ['Own dir', 'Attach'],
    });
    expect(asked).toMatchObject({
      value: {
        ok: true,
        view: {
          id: askId,
          cards: [{ id: card, title: 'Fix it', status: 'proposed' }],
          humanActions: expect.arrayContaining([
            expect.objectContaining({ kind: 'answer', options: ['Own dir', 'Attach'] }),
          ]),
        },
      },
    });
    expect(await invoke('neo.work.cancel', { id: card })).toMatchObject({
      value: {
        ok: true,
        ask: {
          humanActions: expect.arrayContaining([expect.objectContaining({ kind: 'answer' })]),
        },
      },
    });
  });

  test('a work operation answers with each card phase and the wake-note PR verdict', async () => {
    const askId = await openAsk();
    const card = (await propose('card-1', askId)).value!.work!.id;
    service.workPrs.record(
      card,
      [
        {
          url: 'https://github.com/lsm/HyperNeo/pull/6716',
          state: 'OPEN',
          checks: 'failing',
          review: 'none',
        },
      ],
      Date.now()
    );
    expect(await invoke('neo.work.cancel', { id: card })).toMatchObject({
      value: {
        ok: true,
        ask: {
          id: askId,
          cards: [{ id: card, phase: 'cancelled', pr: 'failed' }],
        },
      },
    });
  });

  test('settle takes askId like the other ask operations, and still publishes its fields', async () => {
    const askId = await openAsk();
    for (const itemId of ['i1', 'i2'])
      await invoke('neo.ask.tick', { askId, itemId, state: 'met', evidence: 'PR #12 merged.' });
    expect(
      await invoke('neo.ask.settle', {
        askId,
        outcome: 'achieved',
        summary: 'Merged in #12.',
        evidence: 'PR #12 merged.',
      })
    ).toMatchObject({ value: { ok: true, ask: { id: askId, status: 'achieved' } } });
    const settle = createNeoOperations(service).find((op) => op.name === 'neo.ask.settle')!;
    const schema = z.toJSONSchema(settle.inputSchema, { io: 'input' }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['id', 'outcome']));
  });

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

  test('reads one ask with its cards and their reports', async () => {
    const askId = await openAsk();
    const other = (
      await invoke('neo.ask.open', { ...opening, requestKey: 'other', ask: 'Other' }, nextMessage)
    ).value!.ask!.id;
    const workId = (await propose('card-1', askId)).value!.work!.id;
    await propose('card-2', other);
    const queued = service.repo.transitionWork(workId, service.repo.getWork(workId)!, {
      status: 'queued',
    })!;
    service.repo.transitionWork(workId, queued, { status: 'reported', report: 'Merged it.' });

    const scoped = (await invoke('neo.snapshot', { askId })) as {
      value?: { asks: NeoAsk[]; work: { id: string; report: string | null }[] };
    };
    expect(scoped.value?.asks.map((ask) => ask.id)).toEqual([askId]);
    expect(scoped.value?.work).toEqual([
      expect.objectContaining({ id: workId, report: 'Merged it.' }),
    ]);
    expect(await invoke('neo.snapshot', { askId: 'missing' })).toMatchObject({
      value: { ok: false, reason: 'Ask not found.' },
    });
  });

  test("an ask-scoped read shows the cards' reports but not the concern's private context", async () => {
    service.repo.saveConcern({ id: 'c1', title: 'C1', summary: 'S', context: 'Private' }, 0);
    const askId = (
      await invoke('neo.ask.open', { ...opening, requestKey: 'scoped', concernId: 'c1' })
    ).value!.ask!.id;
    const scoped = (await invoke('neo.snapshot', { askId })) as {
      value?: { concerns: { id: string; context: string }[] };
    };
    expect(scoped.value?.concerns).toEqual([expect.objectContaining({ id: 'c1', context: '' })]);
  });

  test("a context holder cannot read another concern's ask, whatever concern it names", async () => {
    const askId = await openAsk();
    service.repo.saveConcern({ id: 'c1', title: 'C1', summary: '', context: '' }, 0);
    db.createSession(createTestSession('holder'));
    service.repo.reserveBinding({ sessionId: 'holder', kind: 'concern', concernId: 'c1' });
    const holder: OperationCaller = { source: 'mcp', sessionId: 'holder', role: 'neo' };
    for (const input of [{ askId }, { concernId: 'c1', askId }])
      expect(await invoke('neo.snapshot', input, holder)).toMatchObject({
        value: { ok: false, reason: 'This context holder cannot access another concern.' },
      });
    expect(await invoke('neo.snapshot', { askId: 'missing' }, holder)).toMatchObject({
      value: { ok: false, reason: 'Ask not found.' },
    });
  });

  test("an ask-scoped read lists the ask's newest cards first, within the snapshot's bounds", async () => {
    const askId = await openAsk();
    for (let index = 0; index < 12; index++) await propose(`card-${index}`, askId);
    const ids = service.askRecords.get(askId)!.workIds;
    expect(ids).toHaveLength(12);
    const scoped = (await invoke('neo.snapshot', { askId })) as {
      value?: { work: { id: string }[] };
    };
    expect(scoped.value?.work.map((item) => item.id)).toEqual(ids.slice(-10).reverse());
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

    const legacy = await invoke('neo.ask.open', opening, nextMessage);
    expect(legacy.value!.ask!.doneItems?.map((done) => done.text)).toEqual([
      'implementation ready',
      'CI green',
    ]);
    expect(
      await invoke('neo.ask.open', { ...opening, requestKey: 'none', doneWhen: undefined })
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });

  test.each([
    { doneWhen: '- Merged to dev' },
    { doneItems: [{ text: 'PR merged' }] },
    { doneItems: [{ text: 'Deployed', check: 'coding.pr_merged' }] },
  ])('refuses an unchecked outcome on open without creating an ask: %j', async (change) => {
    expect(await invoke('neo.ask.open', { ...opening, ...change })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('outcome_check_required') },
    });
    expect(service.askRecords.list()).toEqual([]);
  });

  test('accepts matching checks on open and edit and preserves them during watch-only tracking', async () => {
    const opened = await invoke('neo.ask.open', {
      ...opening,
      doneItems: [{ text: 'Merged to dev', check: 'coding.pr_merged' }],
    });
    const askId = opened.value!.ask!.id;
    expect(opened.value?.ask?.doneItems?.[0].check).toBe('coding.pr_merged');
    expect(
      await invoke('neo.ask.edit', {
        askId,
        add: [{ text: 'Deployed', check: 'coding.deployed' }],
        track: [{ itemId: 'i1', watch: ['https://github.com/lsm/HyperNeo/pull/42'] }],
      })
    ).toMatchObject({ value: { ok: true } });
    expect(service.askRecords.get(askId)?.doneItems).toMatchObject([
      { check: 'coding.pr_merged', watch: ['https://github.com/lsm/HyperNeo/pull/42'] },
      { check: 'coding.deployed' },
    ]);
    const before = service.askRecords.get(askId);
    expect(
      await invoke('neo.ask.edit', {
        askId,
        track: [{ itemId: 'i1', check: 'coding.deployed' }],
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('coding.pr_merged') } });
    expect(service.askRecords.get(askId)).toEqual(before);
  });

  test('a refused added outcome rolls back the entire edit before any write', async () => {
    const askId = await openAsk();
    const before = service.askRecords.get(askId);
    expect(
      await invoke('neo.ask.edit', {
        askId,
        remove: ['i1'],
        add: [{ text: 'PR merged' }],
        track: [{ itemId: 'i2', watch: ['https://github.com/lsm/HyperNeo/pull/42'] }],
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('coding.pr_merged') } });
    expect(service.askRecords.get(askId)).toEqual(before);
  });

  test('leaves untouched legacy outcomes alone but validates changed tracking', async () => {
    const askId = await openAsk();
    service.askRecords.editItems(
      askId,
      planNeoAskEdit(service.askRecords.get(askId)!, {
        askId,
        add: [{ text: 'Deployed', check: null }],
        remove: [],
        track: [],
      }),
      Date.now()
    );
    const legacy = service.askRecords.get(askId)!.doneItems!.find((item) => item.id === 'i3');
    expect(
      await invoke('neo.ask.edit', { askId, add: [{ text: 'Documentation ready' }] })
    ).toMatchObject({ value: { ok: true } });
    expect(service.askRecords.get(askId)!.doneItems!.find((item) => item.id === 'i3')).toEqual(
      legacy
    );
    const before = service.askRecords.get(askId);
    expect(
      await invoke('neo.ask.edit', {
        askId,
        track: [{ itemId: 'i3', watch: ['https://github.com/lsm/HyperNeo/pull/42'] }],
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('coding.deployed') } });
    expect(service.askRecords.get(askId)).toEqual(before);
    expect(
      await invoke('neo.ask.edit', {
        askId,
        track: [{ itemId: 'i3', check: 'coding.deployed' }],
      })
    ).toMatchObject({ value: { ok: true } });
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
      { id: 'inbox-triage', describe: 'Inbox triage', instructions: () => 'File the inbox daily.' },
    ];
    db.updateGlobalSettings({ neo: { packs: ['coding', 'inbox-triage'] } });
    const opened = await invoke('neo.ask.open', { ...opening, pack: 'inbox-triage' });
    expect(opened).toMatchObject({ value: { ok: true, ask: { pack: 'inbox-triage' } } });
    expect((opened.value as { packBriefing?: string }).packBriefing).toBe('File the inbox daily.');
    expect(await invoke('neo.pack.read', { id: 'inbox-triage' })).toMatchObject({
      value: { ok: true, instructions: 'File the inbox daily.' },
    });
    expect(neoPrompt(null, service.packBriefs())).toContain('inbox-triage — Inbox triage');
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
        reason: expect.stringContaining('checklist_incomplete: i1 "implementation ready"'),
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
      question: 'Which API?',
      options: ['REST', 'GraphQL'],
    });
    expect(service.askRecords.get(askId)?.status).toBe('blocked');

    await propose('card-1', askId);

    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open', settledAt: null });
  });

  test('ticks checklist items met, and nobody can tick one needs_you', async () => {
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

    const needsYou = {
      askId,
      itemId: 'i2',
      state: 'needs_you',
      evidence: 'Is red CI on main acceptable?',
    };
    for (const caller of [neo, { source: 'rpc', principal: 'local' } as OperationCaller])
      expect(await invoke('neo.ask.tick', needsYou, caller)).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('needs_you_removed') },
      });
    expect(service.askRecords.get(askId)).toMatchObject({
      status: 'open',
      doneItems: [expect.anything(), expect.objectContaining({ state: 'pending' })],
    });
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

  test('a decision Neo settles waiting on is asked as its own question it cannot drop', async () => {
    const askId = await openAsk();
    for (const itemId of ['i1', 'i2'])
      await invoke('neo.ask.tick', { askId, itemId, state: 'met', evidence: 'PR #12 merged.' });
    const waiting = {
      id: askId,
      outcome: 'waiting',
      summary: 'Decide whether to assign #6545.',
      evidence: 'Nobody owns #6545 yet.',
      question: 'Assign #6545 to the web session?',
      options: ['Assign it', 'Leave it'],
    };
    expect(await invoke('neo.ask.settle', waiting)).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'waiting',
          waitingItem: 'i3',
          doneItems: [
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
              id: 'i3',
              text: 'Assign #6545 to the web session?',
              question: 'Assign #6545 to the web session?',
              options: ['Assign it', 'Leave it'],
              kind: 'decision',
              state: 'needs_you',
              evidence: 'Nobody owns #6545 yet.',
              decision: true,
            }),
          ],
        },
      },
    });
    for (const outcome of ['achieved', 'abandoned'])
      expect(
        await invoke('neo.ask.settle', { ...waiting, outcome, summary: 'Done.' })
      ).toMatchObject({ value: { ok: false, reason: expect.stringMatching(/i3/) } });
    expect(
      await invoke('neo.ask.settle', { ...waiting, summary: 'Still deciding #6545.' })
    ).toMatchObject({ value: { ok: true, ask: { waitingItem: 'i3' } } });
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(3);
    const quiet: OperationCaller = { ...neo, neoTurn: { ...neo.neoTurn!, human: false } };
    for (const [name, input] of [
      ['neo.ask.tick', { askId, itemId: 'i3', state: 'met', evidence: 'Decided for them.' }],
      ['neo.ask.edit', { askId, remove: ['i3'] }],
    ] as const)
      expect(await invoke(name, input, quiet)).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('decision_open: i3') },
      });
    expect(
      await invoke(
        'neo.ask.settle',
        { id: askId, outcome: 'abandoned', evidence: 'Dropped by the user.' },
        { source: 'rpc', principal: 'local' }
      )
    ).toMatchObject({ value: { ok: true, ask: { status: 'abandoned' } } });
  });

  test('a settle never carries a gate: waiting needs something the human can act on', async () => {
    const askId = await openAsk();
    const waiting = {
      id: askId,
      outcome: 'waiting',
      summary: 'Try the keyboard on the phone.',
      evidence: 'The fix is on the phone build.',
      kind: 'action',
    };
    for (const outcome of ['waiting', 'blocked'])
      expect(await invoke('neo.ask.settle', { ...waiting, outcome })).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('question_required') },
      });
    expect(
      await invoke('neo.ask.settle', { ...waiting, question: 'Did the keyboard hide?' })
    ).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('Pass question and options together'),
    });
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(2);
    expect(
      await invoke('neo.ask.settle', {
        ...waiting,
        question: 'Did the keyboard hide?',
        options: ['It hid', 'Still showing'],
        kind: 'action',
      })
    ).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'waiting',
          waitingItem: 'i3',
          doneItems: expect.arrayContaining([
            expect.objectContaining({
              id: 'i3',
              kind: 'action',
              question: 'Did the keyboard hide?',
              options: ['It hid', 'Still showing'],
            }),
          ]),
        },
      },
    });
    expect(
      await invoke('neo.ask.settle', { ...waiting, summary: 'Still waiting on the phone check.' })
    ).toMatchObject({ value: { ok: true, ask: { status: 'waiting', waitingItem: 'i3' } } });
  });

  test('items a settle creates are kind decision or action, as for every question', async () => {
    const askId = await openAsk();
    const waiting = {
      id: askId,
      outcome: 'waiting',
      summary: 'Pick the release date.',
      evidence: 'Two dates fit.',
      question: 'Which release date?',
      options: ['Friday', 'Monday'],
    };
    for (const name of ['neo.ask.settle', 'neo.ask.question'] as const) {
      const input =
        name === 'neo.ask.settle'
          ? waiting
          : { askId, question: waiting.question, options: waiting.options };
      expect(await invoke(name, { ...input, kind: 'wait' })).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('not_the_human') },
      });
      expect(await invoke(name, { ...input, kind: 'approval' })).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('approval_on_ask') },
      });
    }
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(2);
    expect(await invoke('neo.ask.settle', { ...waiting, kind: 'decision' })).toMatchObject({
      value: { ok: true, ask: { status: 'waiting', waitingItem: 'i3' } },
    });
    expect(requireNeoAskItemKind(undefined, 'v')).toEqual({ value: 'v' });
    expect(requireNeoAskItemKind('action', 'v')).toEqual({ value: 'v' });
  });

  test('renewed approval is refused while the approval is active and no card has stalled', async () => {
    const askId = await openAsk();
    const cardId = (await propose('card-1', askId)).value!.work!.id;
    service.repo.transitionWork(cardId, service.repo.getWork(cardId)!, { status: 'queued' });
    expect(service.askRecords.get(askId)?.approvedAt).toEqual(expect.any(Number));
    const renew = {
      id: askId,
      outcome: 'waiting',
      summary: 'Approve again to keep the login fix going.',
      evidence: 'The card made 20 continues.',
    };
    for (const outcome of ['waiting', 'blocked'])
      expect(await invoke('neo.ask.settle', { ...renew, outcome })).toMatchObject({
        value: { ok: false, reason: expect.stringContaining('approval_active') },
      });
    expect(
      await invoke('neo.ask.question', {
        askId,
        question: 'Re-approve the login fix?',
        options: ['Approve', 'Stop'],
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('approval_on_ask') } });
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
    const unapproved = await invoke(
      'neo.ask.open',
      { ...opening, requestKey: 'never-approved' },
      { source: 'rpc', principal: 'local' }
    );
    const unapprovedId = unapproved.value!.ask!.id;
    expect(service.askRecords.get(unapprovedId)?.approvedAt).toBeNull();
    expect(await invoke('neo.ask.settle', { ...renew, id: unapprovedId })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('question_required') },
    });

    service.isContinueStalled = (id: string) => id === cardId;
    expect(await invoke('neo.ask.settle', renew)).toMatchObject({
      value: { ok: true, ask: { status: 'waiting', waitingItem: null } },
    });
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(2);
  });

  test('a decision item is written only by the settle that wins the status check', async () => {
    const askId = await openAsk();
    const decision = { id: 'i3', position: 2, text: 'Pick the release date.' };
    const stale = { id: askId, status: 'waiting' as const };
    expect(
      service.askRecords.settle(stale, 'waiting', 'Pick it.', 'Two dates fit.', 'i3', decision)
    ).toBeNull();
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(2);
    expect(
      service.askRecords.settle(
        { id: askId, status: 'open' },
        'waiting',
        'Pick it.',
        'Two dates fit.',
        'i3',
        decision
      )?.doneItems?.[2]
    ).toMatchObject({ id: 'i3', state: 'needs_you', evidence: 'Two dates fit.' });
    const taken = { id: askId, status: 'waiting' as const };
    service.askRecords.reopen(taken);
    expect(
      service.askRecords.settle(
        { id: askId, status: 'open' },
        'waiting',
        'Pick again.',
        'A third date.',
        'i3',
        decision
      )
    ).toBeNull();
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
  });

  test('a question adds its item however long the checklist is', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.edit', {
      askId,
      add: Array.from({ length: 10 }, (_, index) => ({ text: `step ${index}` })),
    });
    expect(
      await invoke('neo.ask.settle', {
        id: askId,
        outcome: 'waiting',
        summary: 'Pick the release date.',
        evidence: 'Two dates fit.',
        question: 'Which release date?',
        options: ['Friday', 'Monday'],
      })
    ).toMatchObject({ value: { ok: true, ask: { status: 'waiting', waitingItem: 'i13' } } });
  });

  test("an item Neo only has an agent's word for is reported, never met", async () => {
    const askId = await openAsk();
    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i1',
        state: 'met',
        evidence: 'Agent report (iMac state not independently readable by the daemon)',
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('unverified') } });
    await invoke('neo.ask.tick', {
      askId,
      itemId: 'i2',
      state: 'met',
      evidence: 'CI run 42 green.',
    });
    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i1',
        state: 'reported',
        evidence: 'The fullstack session says the iMac is updated.',
      })
    ).toMatchObject({
      value: {
        ok: true,
        ask: { status: 'waiting', waitingItem: 'i1', outcome: 'Confirm: implementation ready' },
      },
    });
    expect(
      await invoke('neo.ask.settle', {
        id: askId,
        outcome: 'achieved',
        summary: 'Done.',
        evidence: 'Agent says so.',
      })
    ).toMatchObject({
      value: {
        ok: false,
        reason: expect.stringContaining('i1 "implementation ready" is reported'),
      },
    });
    expect(
      await invoke(
        'neo.ask.tick',
        { askId, itemId: 'i1', state: 'met', evidence: 'The human confirmed it.' },
        { source: 'rpc', principal: 'local' }
      )
    ).toMatchObject({ value: { ok: true, ask: { status: 'open' } } });
  });

  test('a reported item waits on the human only once nothing else is pending', () => {
    const item = (id: string, state: 'pending' | 'met' | 'reported') => ({
      id,
      text: id,
      state,
      evidence: null,
      check: null,
      metBy: null,
      removed: false,
      addedAt: null,
    });
    const ask = { status: 'open', waitingItem: null } as unknown as NeoAsk;
    expect(
      planNeoAskTickStatus({ ...ask, doneItems: [item('i1', 'reported'), item('i2', 'pending')] })
    ).toEqual({ status: 'unchanged' });
    expect(
      planNeoAskTickStatus({ ...ask, doneItems: [item('i1', 'reported'), item('i2', 'met')] })
    ).toEqual({ status: 'waiting', outcome: 'Confirm: i1', item: 'i1' });
  });

  test('neo.ask.question asks a decision as its own item, and the human answers it back to Neo', async () => {
    const askId = await openAsk();
    expect(
      await invoke('neo.ask.question', {
        askId,
        question: 'Is red CI on main acceptable?',
        options: ['Yes', 'Yes'],
      })
    ).toMatchObject({ kind: 'failed', message: expect.stringContaining('Options must differ') });
    expect(
      await invoke('neo.ask.question', {
        askId,
        question: 'Is red CI on main acceptable?',
        options: ['Accept it'],
      })
    ).toMatchObject({ kind: 'failed' });
    const asked = {
      askId,
      question: 'Is red CI on main acceptable?',
      options: ['Accept it', 'Fix CI first'],
    };
    expect(await invoke('neo.ask.question', asked, { ...neo, sessionId: 'other' })).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.ask.question', asked)).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'waiting',
          waitingItem: 'i3',
          outcome: 'Is red CI on main acceptable?',
          doneItems: [
            expect.objectContaining({ id: 'i1', state: 'pending' }),
            expect.objectContaining({ id: 'i2', state: 'pending' }),
            expect.objectContaining({
              id: 'i3',
              text: 'Is red CI on main acceptable?',
              state: 'needs_you',
              kind: 'decision',
              decision: true,
              options: ['Accept it', 'Fix CI first'],
            }),
          ],
        },
      },
    });
    expect(await invoke('neo.ask.question', asked)).toMatchObject({
      value: { ok: true, ask: { waitingItem: 'i3' } },
    });
    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(3);
    const snapshot = await invoke('neo.snapshot', {});
    expect(
      (
        snapshot.value as { askViews?: { askId: string; humanActions?: unknown[] }[] }
      ).askViews?.find((view) => view.askId === askId)?.humanActions
    ).toContainEqual({
      kind: 'answer',
      itemId: 'i3',
      step: null,
      question: 'Is red CI on main acceptable?',
      options: ['Accept it', 'Fix CI first'],
    });
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    const answer = { askId, itemId: 'i3', choice: 'Fix CI first' };
    service.deliverAskAnswer = async () => {
      throw new Error('mailbox rejected');
    };
    expect(await invoke('neo.ask.answer', answer, user)).toMatchObject({
      kind: 'failed',
      message: 'mailbox rejected',
    });
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({ state: 'needs_you' });
    const delivered = mock(async (_ask: NeoAsk, _item: unknown, _choice: string) => {});
    service.deliverAskAnswer = delivered;
    expect(await invoke('neo.ask.answer', answer)).toMatchObject({ value: { ok: false } });
    expect(await invoke('neo.ask.answer', answer, user)).toMatchObject({
      value: {
        ok: true,
        ask: {
          status: 'open',
          doneItems: [
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
              state: 'met',
              metBy: 'human',
              evidence: 'The human answered: Fix CI first',
            }),
          ],
        },
      },
    });
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]?.slice(1)).toEqual([
      expect.objectContaining({ id: 'i3', text: 'Is red CI on main acceptable?' }),
      'Fix CI first',
      true,
    ]);
    expect(await invoke('neo.ask.answer', answer, user)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('item_not_waiting') },
    });
  });

  test('a result check carries its own options and is met only on its first', async () => {
    const askId = await openAsk();
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    expect(
      await invoke('neo.ask.question', {
        askId,
        question: '这一步成功了吗？',
        options: ['成功了', '没成功'],
        kind: 'action',
      })
    ).toMatchObject({
      value: { ok: true, ask: { status: 'waiting', waitingItem: 'i3' } },
    });
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({
      kind: 'action',
      question: '这一步成功了吗？',
      options: ['成功了', '没成功'],
    });
    const snapshot = await invoke('neo.snapshot', {});
    expect(
      (
        snapshot.value as { askViews?: { askId: string; humanActions?: unknown[] }[] }
      ).askViews?.find((view) => view.askId === askId)?.humanActions
    ).toContainEqual({
      kind: 'answer',
      itemId: 'i3',
      step: null,
      question: '这一步成功了吗？',
      options: ['成功了', '没成功'],
    });
    const delivered = mock(
      async (_ask: NeoAsk, _item: unknown, _choice: string, _met: boolean) => {}
    );
    service.deliverAskAnswer = delivered;
    const answer = { askId, itemId: 'i3', choice: 'Yes' };
    expect(await invoke('neo.ask.answer', answer, user)).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('成功了 or 没成功') },
    });
    expect(await invoke('neo.ask.answer', { ...answer, choice: '没成功' }, user)).toMatchObject({
      value: { ok: true, ask: { status: 'waiting' } },
    });
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({ state: 'needs_you' });
    expect(delivered.mock.calls[0]?.slice(2)).toEqual(['没成功', false]);
    await invoke('neo.ask.answer', { ...answer, choice: '成功了' }, user);
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({
      state: 'met',
      metBy: 'human',
    });
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
    expect(delivered.mock.calls[1]?.slice(2)).toEqual(['成功了', true]);
  });

  test('a question without kind is a decision, whatever its options say', async () => {
    const askId = await openAsk();
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    await invoke('neo.ask.question', {
      askId,
      question: 'Did the keyboard hide?',
      options: ['Yes', 'Not yet'],
    });
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({ kind: 'decision' });
    service.deliverAskAnswer = mock(async () => {});
    await invoke('neo.ask.answer', { askId, itemId: 'i3', choice: 'Not yet' }, user);
    expect(service.askRecords.get(askId)?.doneItems?.[2]).toMatchObject({ state: 'met' });
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

  test('a settled ask keeps only its identity and outcome for Neo, and its full text over RPC or by askId', async () => {
    const askId = await openAsk();
    await invoke(
      'neo.ask.settle',
      { id: askId, outcome: 'achieved', evidence: 'PR #12 merged after green CI.' },
      { source: 'rpc', principal: 'local' }
    );
    const compact = (await invoke('neo.snapshot', {})).value?.asks;
    expect(compact).toEqual([
      expect.objectContaining({
        id: askId,
        title: opening.title,
        status: 'achieved',
        ask: '',
        doneWhen: '',
        evidence: null,
        doneItems: [],
      }),
    ]);
    const full = { ask: opening.ask, doneWhen: opening.doneWhen };
    expect(
      (await invoke('neo.snapshot', {}, { source: 'rpc', principal: 'local' })).value?.asks
    ).toEqual([expect.objectContaining({ id: askId, ...full })]);
    expect((await invoke('neo.snapshot', { askId })).value?.asks).toEqual([
      expect.objectContaining({ id: askId, ...full }),
    ]);
  });

  test('retrying an offer settle after its card started is a replay, not a new question', async () => {
    const askId = await openAsk();
    const offered = (await propose('card-1', askId)).value!.work!.id;
    const offer = {
      id: askId,
      outcome: 'waiting',
      summary: 'Start the login fix?',
      evidence: 'Offered a work item; nothing started.',
    };
    expect(await invoke('neo.ask.settle', offer)).toMatchObject({ value: { ok: true } });
    service.repo.transitionWork(offered, service.repo.getWork(offered)!, { status: 'queued' });
    expect(await invoke('neo.ask.settle', offer)).toMatchObject({
      value: { ok: true, ask: { status: 'waiting', outcome: 'Start the login fix?' } },
    });
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

    expect(service.askRecords.get(askId)?.doneItems).toHaveLength(2);

    await service.start(offered).catch(() => {});
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open', settledAt: null });
    await invoke('neo.ask.tick', { askId, itemId: 'i1', state: 'met', evidence: 'PR #12 merged.' });
    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
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
    const second = (await invoke('neo.ask.open', { ...opening, requestKey: 'other' }, nextMessage))
      .value!.ask!.id;
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

  test('reported stays refused for what the daemon reads itself', async () => {
    const askId = await openAsk();
    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i2',
        state: 'reported',
        evidence: 'The session says it merged.',
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('daemon_readable') } });
  });

  test('a legacy needs_you item goes back to pending and Neo hears why once its card starts', async () => {
    const askId = await openAsk();
    const cardId = (await propose('card-1', askId)).value!.work!.id;
    expect(service.repo.getWork(cardId)?.status).toBe('proposed');
    service.askRecords.tickItem(
      askId,
      {
        id: 'i2',
        state: 'needs_you',
        evidence: 'The fix needs a go-ahead.',
        metBy: null,
        action: `Click Start work on card ${cardId}`,
        kind: 'action',
        waitCard: cardId,
      },
      Date.now()
    );
    service.askRecords.settle({ id: askId, status: 'open' }, 'waiting', 'x', 'x', 'i2');
    expect(service.askRecords.get(askId)?.doneItems?.[1]?.waitCard).toBe(cardId);
    const delivered = mock(async (..._args: unknown[]) => {});
    (service as unknown as { deliverToOrigin: typeof delivered }).deliverToOrigin = delivered;

    await service.clearStaleNeedsYou();
    expect(delivered).not.toHaveBeenCalled();

    const card = service.repo.getWork(cardId)!;
    service.repo.transitionWork(cardId, card, { status: 'queued' });
    await service.clearStaleNeedsYou();

    expect(service.askRecords.get(askId)).toMatchObject({ status: 'open' });
    expect(service.askRecords.get(askId)?.doneItems?.[1]).toMatchObject({ state: 'pending' });
    expect(service.askRecords.get(askId)?.doneItems?.[1]?.waitCard).toBeUndefined();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]?.[2]).toContain(`card ${cardId} no longer waits on the human`);
  });

  test('the human marking an item met wakes Neo once, and Neo ticking it does not', async () => {
    const askId = await openAsk();
    const delivered = mock(async (_ask: NeoAsk, _item: unknown) => {});
    service.deliverAskTicked = delivered;
    const human: OperationCaller = { source: 'rpc', principal: 'local' };
    const done = { askId, itemId: 'i1', state: 'met', evidence: 'Confirmed by the user.' };
    expect(await invoke('neo.ask.tick', done, human)).toMatchObject({ value: { ok: true } });
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]?.[1]).toMatchObject({ id: 'i1', state: 'met' });
    await invoke('neo.ask.tick', done, human);
    await invoke('neo.ask.tick', { ...done, itemId: 'i2', evidence: 'CI run 42 green.' });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  test('one human message opens one ask; a second open names the first', async () => {
    const askId = await openAsk();
    expect(
      await invoke('neo.ask.open', { ...opening, requestKey: 'fix-again', title: 'Fix it again' })
    ).toMatchObject({
      value: { ok: false, reason: expect.stringContaining(`ask_exists_for_message: ask ${askId}`) },
    });
    expect(await invoke('neo.ask.open', opening)).toMatchObject({
      value: { ok: true, ask: { id: askId } },
    });
  });

  test('folds a duplicate ask into another: its items and cards move and it closes superseded', async () => {
    const targetId = await openAsk();
    const later: OperationCaller = { ...neo, neoTurn: { ...neo.neoTurn!, messageId: 'ask-2' } };
    const duplicate = await invoke(
      'neo.ask.open',
      { ...opening, requestKey: 'dup', doneWhen: '- guard merged' },
      later
    );
    const sourceId = duplicate.value!.ask!.id;
    const card = (await propose('dup-card', sourceId)).value!.work!.id;
    expect(await invoke('neo.ask.fold', { askId: sourceId, intoAskId: sourceId })).toMatchObject({
      kind: 'failed',
    });
    expect(await invoke('neo.ask.fold', { askId: sourceId, intoAskId: targetId })).toMatchObject({
      value: { ok: true, ask: { id: targetId, workIds: [card] } },
    });
    expect(service.askRecords.get(targetId)?.doneItems?.map((item) => item.text)).toEqual([
      'implementation ready',
      'CI green',
      'guard merged',
    ]);
    expect(service.askRecords.get(sourceId)).toMatchObject({
      status: 'abandoned',
      outcome: `Superseded: folded into ask ${targetId}.`,
      workIds: [],
    });
    expect(await invoke('neo.ask.fold', { askId: sourceId, intoAskId: targetId })).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('ask_settled') },
    });
  });

  test('an ask holds as many items as it needs through open, edit and fold', async () => {
    const steps = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ text: `step ${from + index}` }));
    const opened = await invoke('neo.ask.open', { ...opening, doneItems: steps(1, 13) });
    const targetId = opened.value!.ask!.id;
    expect(opened.value!.ask!.doneItems).toHaveLength(13);
    expect(await invoke('neo.ask.edit', { askId: targetId, add: steps(14, 12) })).toMatchObject({
      value: { ok: true },
    });
    expect(service.askRecords.get(targetId)!.doneItems).toHaveLength(25);
    const later: OperationCaller = { ...neo, neoTurn: { ...neo.neoTurn!, messageId: 'ask-2' } };
    const duplicate = await invoke(
      'neo.ask.open',
      { ...opening, requestKey: 'dup', doneItems: steps(26, 15) },
      later
    );
    expect(
      await invoke('neo.ask.fold', { askId: duplicate.value!.ask!.id, intoAskId: targetId })
    ).toMatchObject({ value: { ok: true } });
    const items = service.askRecords.get(targetId)!.doneItems!;
    expect(items.filter((item) => !item.removed)).toHaveLength(40);
    expect(items.at(-1)?.text).toBe('step 40');
    expect(await invoke('neo.ask.edit', { askId: targetId, add: steps(41, 1) })).toMatchObject({
      value: { ok: true },
    });
  });

  test('Neo cannot tick a watched item met; the daemon ticks it', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.edit', {
      askId,
      add: [{ text: 'Watched PR complete', watch: ['https://github.com/o/r/pull/9'] }],
    });
    expect(
      await invoke('neo.ask.tick', {
        askId,
        itemId: 'i3',
        state: 'met',
        evidence: 'neo.github.read says merged.',
      })
    ).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('daemon_ticks_watched') },
    });
  });

  test("an agent's word or Neo's tick never meets an item the daemon reads", async () => {
    const askId = await openAsk();
    service.askRecords.editItems(
      askId,
      planNeoAskEdit(service.askRecords.get(askId)!, {
        askId,
        add: [
          { text: 'Deployed to the laptop and the iMac', check: null },
          { text: 'lsm/HyperNeo#6700 merged', check: null },
          { text: 'Running on both daemons', check: 'coding.deployed' },
          { text: 'The copy reads well', check: null },
        ],
        remove: [],
        track: [],
      }),
      Date.now()
    );
    const tick = (itemId: string, state: 'met' | 'reported', evidence: string) =>
      invoke('neo.ask.tick', { askId, itemId, state, evidence });
    for (const [itemId, state, code] of [
      ['i3', 'met', 'daemon_reads_deploy'],
      ['i3', 'reported', 'daemon_reads_deploy'],
      ['i4', 'met', 'daemon_reads_github'],
      ['i5', 'met', 'daemon_ticks_check'],
      ['i5', 'reported', 'daemon_ticks_check'],
    ] as const)
      expect(await tick(itemId, state, 'Deployed on both, I read it.')).toMatchObject({
        value: { ok: false, reason: expect.stringContaining(code) },
      });
    expect(await tick('i6', 'met', 'I read the page; the copy is clear.')).toMatchObject({
      value: { ok: true },
    });
    expect(
      await invoke('neo.ask.edit', {
        askId,
        track: [
          { itemId: 'i3', check: 'coding.deployed' },
          { itemId: 'i4', watch: ['https://github.com/lsm/HyperNeo/pull/6700'] },
        ],
      })
    ).toMatchObject({ value: { ok: true } });
    const items = service.askRecords.get(askId)!.doneItems!;
    expect(items.find((item) => item.id === 'i3')).toMatchObject({
      check: 'coding.deployed',
      state: 'pending',
    });
    expect(items.find((item) => item.id === 'i4')?.watch).toEqual([
      'https://github.com/lsm/HyperNeo/pull/6700',
    ]);
    expect(
      await invoke('neo.ask.edit', { askId, track: [{ itemId: 'i6', check: 'coding.deployed' }] })
    ).toMatchObject({
      value: { ok: false, reason: expect.stringContaining('item_not_trackable') },
    });
  });

  test('a turn that hit its limit gets one note listing the asks it already opened', async () => {
    const results = db.getSDKMessageRepo();
    const save = (uuid: string, subtype: string) =>
      results.saveSDKMessage('root', {
        type: 'result',
        subtype,
        uuid,
        session_id: 'root',
      } as unknown as SDKUserMessage);
    save('r1', 'success');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const askId = await openAsk();
    await new Promise((resolve) => setTimeout(resolve, 5));
    save('r2', 'error_max_turns');
    const delivered = mock(async (..._args: unknown[]) => {});
    (service as unknown as { deliverToOrigin: typeof delivered }).deliverToOrigin = delivered;
    await service.noteTurnLimit('root');
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]?.[1]).toBe('neo-turn-limit:r2');
    expect(delivered.mock.calls[0]?.[2]).toContain(`- ask ${askId} "${opening.title}" (open`);
  });

  test('a dropped turn-limit note does not stop the next cut-off turn from getting its own', async () => {
    const results = db.getSDKMessageRepo();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const save = (uuid: string, type: 'result' | 'user', subtype?: string) =>
      results.saveSDKMessage('root', {
        type,
        subtype,
        uuid,
        session_id: 'root',
        ...(type === 'user'
          ? {
              inputKind: 'system',
              message: { role: 'user', content: 'Your last turn hit its turn limit.' },
            }
          : {}),
      } as unknown as SDKUserMessage);
    save('r1', 'result', 'error_max_turns');
    await pause();
    save('neo-turn-limit:r1', 'user');
    await pause();
    save('r2', 'result', 'error_max_turns');
    const delivered = mock(async (..._args: unknown[]) => {});
    (service as unknown as { deliverToOrigin: typeof delivered }).deliverToOrigin = delivered;
    await service.noteTurnLimit('root');
    expect(delivered).not.toHaveBeenCalled();
    db.getDatabase()
      .prepare("UPDATE sdk_messages SET send_status = 'failed' WHERE sdk_uuid = ?")
      .run('neo-turn-limit:r1');
    await service.noteTurnLimit('root');
    expect(delivered.mock.calls.map((call) => call[1])).toEqual(['neo-turn-limit:r2']);
  });

  test('edits the checklist in view: removed items stay listed, and dropping a question reopens the ask', async () => {
    const askId = await openAsk();
    await invoke('neo.ask.question', {
      askId,
      question: 'Is red CI on main acceptable?',
      options: ['Accept it', 'Fix CI first'],
    });
    expect(service.askRecords.get(askId)?.status).toBe('waiting');
    await invoke('neo.ask.edit', { askId, remove: ['i3'] });
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
            expect.objectContaining({ id: 'i3', removed: true }),
            expect.objectContaining({
              id: 'i4',
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
  test('refuses work filed under an ask from another concern', () => {
    expect(requireNeoWorkAsk({ ...ask, concernId: 'c1' }, input, neo)).toEqual({
      reason: {
        ok: false,
        reason: 'This ask belongs to another concern; propose under its concernId.',
      },
    });
  });

  test('passes work with no ask, a missing ask, or an ask in its concern', () => {
    expect(requireNeoWorkAsk(null, { concernId: null }, neo)).toEqual({ value: neo });
    expect(requireNeoWorkAsk(null, input, neo)).toEqual({ value: neo });
    expect(requireNeoWorkAsk(ask, input, neo)).toEqual({ value: neo });
  });
});

describe('requireNeoWorkAskOwner', () => {
  const input = { askId: 'a1', concernId: null };
  test('refuses a missing ask or another Neo session, and passes the user', () => {
    expect(requireNeoWorkAskOwner(null, input, neo)).toEqual({
      reason: { ok: false, reason: 'ask_not_found' },
    });
    expect(requireNeoWorkAskOwner(ask, input, { ...neo, sessionId: 'holder' })).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('open your own ask') },
    });
    const user: OperationCaller = { source: 'rpc', principal: 'local' };
    expect(requireNeoWorkAskOwner(ask, input, user)).toEqual({ value: user });
    expect(requireNeoWorkAskOwner(null, { concernId: null }, neo)).toEqual({ value: neo });
  });
});

describe('requireNeoWorkAskLive', () => {
  const input = { askId: 'a1', concernId: null };
  test('refuses work under a settled ask and passes an active one', () => {
    expect(requireNeoWorkAskLive({ ...ask, status: 'achieved' }, input, neo)).toEqual({
      reason: { ok: false, reason: 'ask_settled: this ask is already achieved; open a new ask.' },
    });
    expect(requireNeoWorkAskLive({ ...ask, status: 'blocked' }, input, neo)).toEqual({
      value: neo,
    });
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
    expect(projectNeoSnapshotAsks(asks, 1, 0).map((item) => item.id)).toEqual(['o1', 'b1', 's1']);
  });

  test('says whether each ask draws on an approved pool and whether that pool is spent', () => {
    const approved = { ...ask, id: 'p1', approvedAt: 0, approvedContinues: 3 };
    expect(
      projectNeoSnapshotAsks([approved, { ...ask, id: 'n1' }], 0, NEO_ASK_CONTINUE_WINDOW_MS).map(
        ({ id, pooled, approvalSpent }) => ({ id, pooled, approvalSpent })
      )
    ).toEqual([
      { id: 'p1', pooled: true, approvalSpent: 'expired' },
      { id: 'n1', pooled: false, approvalSpent: null },
    ]);
  });
});

describe('isPooledNeoAsk', () => {
  test('pools continues only for an approved ask that is still live', () => {
    expect(isPooledNeoAsk({ status: 'open', approvedAt: 0 })).toBe(true);
    expect(isPooledNeoAsk({ status: 'waiting', approvedAt: 5 })).toBe(true);
    expect(isPooledNeoAsk({ status: 'achieved', approvedAt: 5 })).toBe(false);
    expect(isPooledNeoAsk({ status: 'open', approvedAt: null })).toBe(false);
    expect(isPooledNeoAsk(null)).toBe(false);
  });
});

describe('projectNeoSnapshotAsks approval', () => {
  const base = {
    id: 'a1',
    status: 'open',
    approvedAt: 1_000,
    workIds: ['w1', 'w2'],
  } as unknown as NeoAsk;
  test('names the stalled cards under each ask', () => {
    expect(
      projectNeoSnapshotAsks([base], 10, 2_000, new Set(['w2', 'other']))[0].stalledWorkIds
    ).toEqual(['w2']);
    expect(projectNeoSnapshotAsks([base], 10, 2_000)[0].stalledWorkIds).toBeUndefined();
  });

  test('a stalled card no longer spends the approval; only its age does', () => {
    expect(projectNeoSnapshotAsks([base], 10, 2_000)[0].approvalSpent).toBeNull();
    expect(
      projectNeoSnapshotAsks([base], 10, 1_000 + NEO_ASK_CONTINUE_WINDOW_MS)[0].approvalSpent
    ).toBe('expired');
  });
});

describe('neoAskApprovalSpent', () => {
  test('is spent only once the window has fully passed, however many continues ran', () => {
    const at = 1_000;
    expect(neoAskApprovalSpent({ approvedAt: at }, at)).toBeNull();
    expect(neoAskApprovalSpent({ approvedAt: at }, at + NEO_ASK_CONTINUE_WINDOW_MS - 1)).toBeNull();
    expect(neoAskApprovalSpent({ approvedAt: at }, at + NEO_ASK_CONTINUE_WINDOW_MS)).toBe(
      'expired'
    );
    expect(neoAskApprovalSpent({ approvedAt: null }, at)).toBeNull();
  });
});

describe('requireNeoAskSettleable', () => {
  const settle = { id: 'a1', outcome: 'achieved' as const, evidence: 'PR merged.' };
  const done = { ...ask, status: 'achieved' as const, outcome: 'PR merged.' };

  test('refuses a different outcome on a final ask', () => {
    expect(requireNeoAskSettleable(settle, { ...done, outcome: 'Other.' })).toEqual({
      reason: { ok: false, reason: 'ask_settled: this ask is already achieved.' },
    });
  });

  test('admits an open ask and an identical replay', () => {
    expect(requireNeoAskSettleable(settle, ask)).toEqual({ value: ask });
    expect(requireNeoAskSettleable(settle, done)).toEqual({ value: done });
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
  const items = (count: number): { text: string; check: null; watch?: string[] }[] =>
    Array.from({ length: count }, (_, i) => ({ text: `t${i}`, check: null }));
  type Track = { itemId: string; check: 'coding.deployed' | null; watch?: string[] }[];
  test.each<
    [string, { add?: ReturnType<typeof items>; remove?: string[]; track?: Track }, string | null]
  >([
    ['an edit by the owner', { add: items(1) }, null],
    ['tracking an open item', { track: [{ itemId: 'i1', check: 'coding.deployed' }] }, null],
    [
      'tracking a removed item',
      { track: [{ itemId: 'i2', check: 'coding.deployed' }] },
      'item_not_trackable',
    ],
    [
      'tracking an item it removes',
      { add: items(1), remove: ['i1'], track: [{ itemId: 'i1', check: 'coding.deployed' }] },
      'item_not_trackable',
    ],
    ['an item already removed', { remove: ['i2'] }, 'item_not_found'],
    ['removing the last item', { remove: ['i1'] }, 'checklist_empty'],
    ['forty more items', { add: items(40) }, null],
    [
      'more than twenty watched refs',
      {
        add: items(3).map((item, i) => ({
          ...item,
          watch: Array.from({ length: 7 }, (_, n) => `https://github.com/o/r/pull/${i * 10 + n}`),
        })),
      },
      'watch_full',
    ],
  ])('%s', (_label, change, reason) => {
    const target = owned;
    const gate = requireNeoAskEdit(
      {
        askId: 'a1',
        add: change.add ?? [],
        remove: change.remove ?? [],
        track: change.track ?? [],
      },
      target
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
        track: [],
      })
    ).toEqual({
      add: [{ text: 'Docs', check: null, id: 'i3', position: 2 }],
      remove: ['i1'],
      track: [],
    });
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
    expect(prompt).toContain('ask each with neo.ask.question, never settle achieved');
    expect(prompt).toContain('A settle never carries a gate on its own');
    expect(prompt).toContain('neo.snapshot returns waitingOnHuman');
    expect(neoPrompt('book-club')).toContain('File work only under asks you opened yourself');
    expect(prompt).toContain('save it straight away with neo.rule.save');
    expect(prompt).toContain('Never ask whether to save it.');
    expect(prompt).toContain('or from precedent: what done meant for the same kind of work');
    expect(prompt).toContain('corrects you with something lasting');
    expect(neoPrompt('book-club')).not.toContain('neo.rule.save as a rule');
  });

  test('carries the enabled packs and their guidance, and keeps the core prompt free of coding examples', () => {
    const prompt = neoPrompt(null);
    expect(prompt).toContain('coding — Software work in git repositories');
    expect(prompt).toContain('pass its id as pack to neo.ask.open');
    expect(prompt).toContain('neo.pack.read {id}');
    expect(prompt).toContain(
      `Guidance for asks under the coding pack:\n${NEO_PACK_CODING_INSTRUCTIONS}`
    );
    expect(prompt).toContain('Otherwise settle the ask: neo.ask.settle');
    const core = neoPrompt(null, []);
    for (const gone of [
      'for code usually merged, not a pull request opened',
      'Merged in #6099.',
      'a git remote that matches the repository the human named',
      'let the app make its own worktree',
      'HyperNeo code is done when merged to dev',
      'Fix merged to dev',
    ]) {
      expect(core).not.toContain(gone);
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
    expect(owned).toContain('Follow the done-check steps in your system prompt');
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
    expect(spent).toContain(
      'Do not continue it. Follow the done-check steps in your system prompt'
    );
  });

  test('names the ask pack, and embeds its guidance only when the system prompt lacks it', () => {
    const fragment = { id: 'coding', instructions: NEO_PACK_CODING_INSTRUCTIONS };
    const inPrompt = driverDoneCheckNote(work, goal, 0, null, {
      ask: { ...ask, pack: 'coding' },
      pack: { ...fragment, inPrompt: true },
    });
    expect(inPrompt).toContain('This ask works under the coding pack');
    expect(inPrompt).not.toContain(NEO_PACK_CODING_INSTRUCTIONS);
    const noted = driverDoneCheckNote(work, goal, 0, null, {
      ask: { ...ask, pack: 'coding' },
      pack: fragment,
    });
    expect(noted).toContain(NEO_PACK_CODING_INSTRUCTIONS);
    expect(driverDoneCheckNote(work, goal, 0, null, { ask, pack: null })).not.toContain(
      'This ask works under'
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
  test('tells Neo to ask a decision with neo.ask.question instead of ticking an outcome item', () => {
    expect(neoPrompt(null)).toContain(
      'reaches them only as neo.ask.question {askId, question, options}'
    );
    expect(neoPrompt(null)).toContain('never tick an outcome item for a decision');
    expect(neoPrompt(null)).not.toContain('needs_you');
  });
});

describe('driverNeedsYouNote', () => {
  test('asks Neo to ask the decision with neo.ask.question before telling the human', () => {
    expect(
      driverNeedsYouNote(
        { id: 'w1', title: 'Fix startup' },
        { adapter: 'claude-desktop', daemon: 'laptop', id: 't1' },
        'A or B?'
      )
    ).toContain('ask it first with neo.ask.question {askId, question, options}');
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

describe('neoAskScope', () => {
  test("admits an ask-scoped read by the ask's own concern, and a missing ask by none", () => {
    expect(neoAskScope({ concernId: 'c1' })).toBe('c1');
    expect(neoAskScope({ concernId: null })).toBe(null);
    expect(neoAskScope(null)).toBe(undefined);
  });
});

describe('requireNeoOwnedLiveAsk', () => {
  test('passes the ask through and turns a refusal into the gate reason', () => {
    const ask = { id: 'a1', status: 'open' } as NeoAsk;
    const refused = { ok: false as const, reason: 'Ask not found.' };
    expect(requireNeoOwnedLiveAsk(ask)).toEqual({ value: ask });
    expect(requireNeoOwnedLiveAsk(refused)).toEqual({ reason: refused });
  });
});

describe('neoAsksForApproval', () => {
  test.each([
    ['Approve again to keep the login fix going.', true],
    ['Needs re-approval after 20 continues.', true],
    ['Renew the approval for this ask.', true],
    ['The approval has expired.', true],
    ['请重新批准这个任务', true],
    ['Approve the design?', false],
    ['Pick the release date.', false],
  ])('%s → %s', (text, asks) => {
    expect(neoAsksForApproval(undefined, text)).toBe(asks);
  });
});

describe('requireNeoAskApprovalLapsed', () => {
  const now = 1_000_000_000;
  test('refuses only while the approval is active and no card has stalled', () => {
    expect(requireNeoAskApprovalLapsed({ approvedAt: now - 1000 }, false, now, 'v')).toMatchObject({
      reason: { ok: false, reason: expect.stringContaining('approval_active') },
    });
    expect(requireNeoAskApprovalLapsed({ approvedAt: now - 1000 }, true, now, 'v')).toEqual({
      value: 'v',
    });
    expect(
      requireNeoAskApprovalLapsed({ approvedAt: now - NEO_ASK_CONTINUE_WINDOW_MS }, false, now, 'v')
    ).toEqual({ value: 'v' });
    expect(requireNeoAskApprovalLapsed({ approvedAt: null }, false, now, 'v')).toEqual({
      value: 'v',
    });
  });
});

describe('neoAskTitleNamedIn', () => {
  test.each([
    [
      'a backticked title in Chinese text',
      '`为 Neo 网页版添加引用回复` 这个要做成一样',
      '为 Neo 网页版添加引用回复',
      true,
    ],
    ['a CJK title run into other text', '为Neo添加引用回复这个也看一下', '为Neo添加引用回复', true],
    ['a plain Latin title', 'For Fix the login bug, also check Safari.', 'Fix the login bug', true],
    ['a title inside a longer word', 'Already done.', 'Read', false],
    ['a title inside an identifier', 'Rename user_login first.', 'login', false],
    ['a title as an identifier part', 'Rename login_page first.', 'login', false],
    [
      'a Latin title glued to more letters',
      'Fix the login bugs everywhere',
      'Fix the login bug',
      false,
    ],
    ['a title in another case', 'fix the login bug', 'Fix the login bug', false],
    ['a title shorter than four characters', 'Fix it now', 'Fix', false],
  ])('%s', (_label, text, title, named) => {
    expect(neoAskTitleNamedIn(text, title)).toBe(named);
  });
});
