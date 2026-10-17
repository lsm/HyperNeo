import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoAsk, NeoAskView, NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { vi } from 'vitest';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { neoCardGroup } from '../../../../src/lib/neo/card-phase.ts';
import {
  isNeoAskReportUnsettled,
  isNeoCardFailedForGood,
  isNeoHumanOwnTurn,
  NEO_TRIGGER_DELIVERY_RETRY_MS,
  type NeoAskTrigger,
  type NeoTriggerSweepDeps,
  neoAskIdleLine,
  neoAskTriggerConcern,
  neoAskTriggerKeys,
  neoHumanTurnOrigin,
  neoTriggerMessageId,
  neoTriggerNote,
  neoTriggerWatchSessions,
  noteNeoAskTrigger,
  planNeoAskTrigger,
  planNeoSettledReports,
  shouldPreemptNeoTurn,
} from '../../../../src/lib/neo/notification-triggers.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { NeoNotificationTriggerRepository } from '../../../../src/storage/repositories/neo-notification-trigger-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { withMintedPublicationId } from '../../../helpers/neo-minted-publication.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const m0 = '30000000-0000-4000-8000-000000000000';
const m1 = '30000000-0000-4000-8000-000000000001';
const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'k1',
  projectId: null,
  originSessionId: root,
  originMessageId: 'm0',
  title: 'Fix the composer',
  ask: 'Fix the composer',
  doneWhen: '',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  createdAt: 10,
  updatedAt: 100,
  settledAt: null,
  workIds: ['w1'],
  doneItems: [],
};
const card = (overrides: Partial<NeoCardView> = {}) =>
  ({
    workId: 'w1',
    phase: 'running',
    group: neoCardGroup(overrides.phase ?? 'running'),
    superseded: false,
    retryable: false,
    primary: { kind: 'open', label: 'Open', link: null },
    ...overrides,
  }) as unknown as NeoCardView;
const view = (overrides: Partial<NeoAskView> = {}) =>
  ({ askId: 'a1', workIds: ['w1'], humanActions: [], ...overrides }) as unknown as NeoAskView;
const work = (id: string) => ({
  id,
  title: `Card ${id}`,
  updatedAt: 500,
  status: 'cancelled' as const,
});
const item = (id: string, state: 'met' | 'pending') => ({
  id,
  text: `Item ${id}`,
  state,
  evidence: null,
  check: null,
  metBy: null,
  removed: false,
  addedAt: null,
});

describe('neoAskTriggerConcern', () => {
  const projectAsk = { ...ask, projectId: 'labs' };

  test('a trigger about an ask goes to the coordinator that opened it, not the project holder', () => {
    expect(neoAskTriggerConcern(projectAsk, { kind: 'neo', projectId: null })).toBeNull();
    expect(neoAskTriggerConcern(ask, { kind: 'project', projectId: 'other' })).toBe('other');
  });

  test('an ask whose opener is no coordinator falls back to its project holder', () => {
    expect(neoAskTriggerConcern(projectAsk, null)).toBe('labs');
    expect(neoAskTriggerConcern(projectAsk, { kind: 'worker', projectId: 'w' })).toBe('labs');
  });
});

describe('shouldPreemptNeoTurn', () => {
  const state = (status: string, messageId?: string) => JSON.stringify({ status, messageId });
  const trigger = (id: string) =>
    id === 'system' ? null : id.startsWith('note') ? `idle:a1:${id}` : `human:${id}`;
  const answered = (value: string) => value === 'human:old';

  test('preempts a human-triggered turn only once its answer is out', () => {
    expect(shouldPreemptNeoTurn(state('processing', 'old'), trigger, answered)).toBe(true);
    expect(shouldPreemptNeoTurn(state('processing', 'fresh'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(state('processing', 'system'), trigger, answered)).toBe(false);
  });

  test('preempts a turn answering a daemon note, which a waiting human message outranks', () => {
    expect(shouldPreemptNeoTurn(state('processing', 'note-1'), trigger, answered)).toBe(true);
    expect(shouldPreemptNeoTurn(state('idle', 'note-1'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(state('idle'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(undefined, trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn('not json', trigger, answered)).toBe(false);
  });
});

describe('trigger keys of an ask', () => {
  const keys = (target: NeoAsk, read = { view: view(), cards: [card()] }, pending = false) =>
    neoAskTriggerKeys(
      target,
      read,
      work,
      () => pending,
      () => true
    ).map((key) => [key.kind, key.key]);

  test('an ask with nothing running wakes Neo once per ended card and once per refused propose', () => {
    const idle = {
      view: view({ workIds: [], idle: true, humanActions: [] }),
      cards: [card({ phase: 'cancelled' })],
    };
    expect(keys(ask, idle)).toEqual([['idle', 'idle:500:0']]);
    expect(keys({ ...ask, workIds: [] }, idle)).toEqual([['idle', 'idle:10:0']]);
    expect(keys({ ...ask, workIds: [], refused: 'No adapter.', refusedCount: 2 }, idle)).toEqual([
      ['idle', 'idle:10:2'],
    ]);
  });

  test('replays ask 7fedf43a: the report at 01:43:52 wakes no idle trigger until the daemon has processed it', () => {
    const at = (time: string) => Date.parse(`2026-10-16T${time}Z`);
    const reportedAt = at('01:43:52.579');
    const card = (id: string) => ({
      id,
      title: `Card ${id}`,
      updatedAt: reportedAt,
      status: 'reported' as const,
    });
    const idle = { view: view({ idle: true, humanActions: [] }), cards: [] };
    const settled = new Map<string, number>();
    const sweep = () =>
      neoAskTriggerKeys(
        ask,
        idle,
        card,
        () => false,
        (id, updatedAt) => settled.get(id) === updatedAt
      ).map((key) => key.kind);
    expect(sweep()).toEqual([]);
    settled.set('w1', at('01:43:26.010'));
    expect(sweep()).toEqual([]);
    settled.set('w1', reportedAt);
    expect(sweep()).toEqual(['idle']);
    expect(
      neoAskTriggerKeys(
        { ...ask, status: 'achieved' },
        idle,
        card,
        () => false,
        () => false
      ).map((key) => key.kind)
    ).toEqual(['outcome']);
    expect(
      isNeoAskReportUnsettled(
        { workIds: ['w1', 'w2'] },
        (id) => (id === 'w2' ? work(id) : card(id)),
        () => false
      )
    ).toBe(true);
  });

  test('a report whose processing failed stays unsettled, so idle waits for the next sweep', () => {
    const settled = planNeoSettledReports(
      [
        { id: 'done', status: 'reported', updatedAt: 1 },
        { id: 'failed', status: 'reported', updatedAt: 2 },
        { id: 'running', status: 'queued', updatedAt: 3 },
      ],
      new Set(['failed'])
    );
    expect([...settled]).toEqual([['done', 1]]);
  });

  test('an idle ask is never quiet: Neo is told to move the work, then to ask the human', () => {
    const idle = { view: view({ workIds: [], idle: true, humanActions: [] }), cards: [] };
    const line = (refusedCount: number) =>
      neoAskTriggerKeys(
        {
          ...ask,
          workIds: [],
          refused: 'The claude-code adapter cannot start work.',
          refusedCount,
        },
        idle,
        work,
        () => false,
        () => true
      ).find((key) => key.kind === 'idle')?.line;
    expect(line(1)).toContain('outcome is not met');
    expect(line(1)).toContain('The claude-code adapter cannot start work.');
    expect(line(100)).toBe(line(1));
    expect(neoAskIdleLine({ refused: null, refusedCount: 0 })).not.toContain('drop');
  });

  test('an ask whose answer is reported and every other item met wakes Neo to publish it', () => {
    const answer = {
      ...item('i2', 'pending'),
      state: 'reported' as const,
      outcomeKind: 'answer' as const,
    };
    expect(keys({ ...ask, doneItems: [item('i1', 'met'), answer] })).toEqual([
      ['outcome', 'outcome:2'],
    ]);
    expect(keys({ ...ask, doneItems: [item('i1', 'pending'), answer] })).toEqual([]);
  });

  test('a ready answer fires its outcome while a question is open, and answering it fires a new one', () => {
    const answer = {
      ...item('i1', 'pending'),
      state: 'reported' as const,
      outcomeKind: 'answer' as const,
    };
    const question = {
      ...item('i2', 'pending'),
      state: 'needs_you' as const,
      kind: 'decision' as const,
    };
    expect(keys({ ...ask, doneItems: [answer, question] })).toEqual([['outcome', 'outcome:2:q1']]);
    const settled = [
      { ...answer, state: 'met' as const },
      { ...question, state: 'met' as const },
    ];
    expect(keys({ ...ask, doneItems: settled })).toEqual([['outcome', 'outcome:2']]);
  });

  test('an achieved ask, or one with every item met, is one outcome trigger', () => {
    expect(keys({ ...ask, status: 'achieved' })).toEqual([['outcome', 'outcome:0']]);
    expect(keys({ ...ask, doneItems: [item('i1', 'met'), item('i2', 'met')] })).toEqual([
      ['outcome', 'outcome:2'],
    ]);
    expect(
      keys({ ...ask, status: 'achieved', doneItems: [item('i1', 'met'), item('i2', 'met')] })
    ).toEqual([['outcome', 'outcome:2']]);
    expect(keys({ ...ask, doneItems: [item('i1', 'met'), item('i2', 'pending')] })).toEqual([]);
  });

  test('each humanAction is its own trigger key', () => {
    const read = {
      view: view({
        humanActions: [
          { kind: 'question', itemId: 'proposal', question: 'Start?', options: ['Later', 'Start'] },
          {
            kind: 'question',
            itemId: 'i3',
            question: 'Ship it?',
            options: ['Yes', 'No'],
          },
        ],
      }),
      cards: [card()],
    };
    expect(keys(ask, read)).toEqual([
      ['action', 'question:proposal'],
      ['action', 'question:i3'],
    ]);
  });

  test('a failed card stays quiet while other work on the ask is still in play', () => {
    const read = {
      view: view({ workIds: ['w1', 'w2'] }),
      cards: [card({ phase: 'failed' }), card({ workId: 'w2', phase: 'running' })],
    };
    expect(keys(ask, read)).toEqual([]);
    read.cards[1] = card({ workId: 'w2', phase: 'merged' });
    expect(keys(ask, read)).toEqual([['failed', 'failed:w1:500']]);
  });

  test('an optional Close is not a reason to interrupt the human', () => {
    const read = {
      view: view(),
      cards: [card({ primary: { kind: 'close', label: 'Close', link: null } })],
    };
    expect(keys(ask, read)).toEqual([]);
  });

  test('a card that failed with no retry is a failure trigger; a retryable or retrying one is not', () => {
    const failed = { view: view(), cards: [card({ phase: 'failed' })] };
    expect(keys(ask, failed)).toEqual([['failed', 'failed:w1:500']]);
    expect(keys(ask, failed, true)).toEqual([]);
    expect(isNeoCardFailedForGood(card({ phase: 'failed', retryable: true }), false)).toBe(false);
    expect(isNeoCardFailedForGood(card({ phase: 'failed', superseded: true }), false)).toBe(false);
  });
});

describe('neoHumanTurnOrigin', () => {
  const human = (id: string) => id === 'm1';

  test('a turn acts for the human message it answers, the one its own continuation carries, or the one the human’s answer carries', () => {
    expect(neoHumanTurnOrigin('m1', 'human:m1', human)).toBe('m1');
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'human:m1', human)).toBe('m1');
    expect(neoHumanTurnOrigin('neo-ask-answer:a1:i2:1', 'human:m1', human)).toBe('m1');
  });

  test('a nudge, a plain continuation or a note acts for no human message', () => {
    expect(neoHumanTurnOrigin('neo-nudge:m1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-ask-ticked:a1:i2:1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:r1', 'human:m1', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'idle:a1:x', human)).toBeNull();
    expect(neoHumanTurnOrigin('neo-turn-limit:human:r1', 'human:m9', human)).toBeNull();
  });
});

describe('isNeoHumanOwnTurn', () => {
  test('the human message and continuations of its own turn are the human’s own turn', () => {
    expect(isNeoHumanOwnTurn('m1', 'human:m1')).toBe(true);
    expect(isNeoHumanOwnTurn('neo-turn-limit:human:r1', 'human:m1')).toBe(true);
    expect(isNeoHumanOwnTurn('neo-turn-limit:r1', 'human:m1')).toBe(false);
    expect(isNeoHumanOwnTurn('neo-nudge:m1', 'human:m1')).toBe(false);
    expect(isNeoHumanOwnTurn('neo-consult:c1:request', 'human:m1')).toBe(false);
    expect(isNeoHumanOwnTurn('neo-turn-limit:human:r1', 'idle:a1:x')).toBe(false);
    expect(isNeoHumanOwnTurn('m1', null)).toBe(false);
  });
});

describe('neoTriggerWatchSessions', () => {
  test('a trigger waits on its owner and on whoever proposed a card not yet started', () => {
    expect(
      neoTriggerWatchSessions(root, [
        { status: 'proposed', originSessionId: 'neo:holder:a' },
        { status: 'queued', originSessionId: 'neo:holder:b' },
        { status: 'proposed', originSessionId: root },
        null,
      ])
    ).toEqual([root, 'neo:holder:a']);
  });
});

describe('neoTriggerMessageId', () => {
  test('uses the trigger identity without an attempt suffix', () => {
    expect(neoTriggerMessageId('outcome:a1:x')).toBe('neo-trigger:outcome:a1:x');
  });
});

describe('planNeoAskTrigger', () => {
  const key = (kind: 'outcome' | 'failed' | 'action', name: string) => ({
    kind,
    key: name,
    line: name,
  });

  test('names the most important new kind, with an id stable for the same transition', () => {
    const keys = [key('action', 'question:proposal'), key('failed', 'failed:w2:1')];
    const id = (planned: ReturnType<typeof planNeoAskTrigger>) =>
      'value' in planned ? planned.value.triggerId : null;
    const first = planNeoAskTrigger(ask, keys);
    expect(first).toMatchObject({
      value: { kind: 'failed', keys: ['question:proposal', 'failed:w2:1'] },
    });
    expect(id(planNeoAskTrigger(ask, [...keys].reverse()))).toBe(id(first));
    expect(id(first)).toMatch(/^failed:a1:/);
    expect(id(planNeoAskTrigger({ ...ask, revision: 1 }, keys))).not.toBe(id(first));
    expect(
      id(
        planNeoAskTrigger(
          ask,
          keys.map((key) => ({ ...key, line: `${key.line} updated` }))
        )
      )
    ).not.toBe(id(first));
  });
});

describe('noteNeoAskTrigger', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function sweepDeps(read: { view: NeoAskView; cards: NeoCardView[] }, busy = false) {
    const recorded = new Map<string, Set<string>>();
    const receipts = new Set<string>();
    const wakes: NeoAskTrigger[] = [];
    const delivery = { ok: true };
    const deps: NeoTriggerSweepDeps = {
      busy: () => busy,
      read: () => read,
      work,
      deliveryRetryPending: () => false,
      reportSettled: () => true,
      recorded: (_askId, id) => receipts.has(id),
      record: (askId, keys, triggerId) => {
        recorded.set(askId, new Set([...(recorded.get(askId) ?? []), ...keys]));
        if (triggerId) receipts.add(triggerId);
      },
      wake: async (_ask, trigger) => {
        wakes.push(trigger);
        return delivery.ok;
      },
    };
    return { deps, wakes, delivery, recorded };
  }
  const startRead = {
    view: view({
      humanActions: [
        { kind: 'question', itemId: 'proposal', question: 'Start?', options: ['Later', 'Start'] },
      ],
    }),
    cards: [],
  };

  test('repeated sweeps skip the exact recorded fact state', async () => {
    const { deps, wakes } = sweepDeps(startRead);
    expect(await noteNeoAskTrigger(ask, deps)).toMatchObject({
      kind: 'action',
      keys: ['question:proposal'],
    });
    await settle();
    expect(await noteNeoAskTrigger(ask, deps)).toBeFalsy();
    expect(await noteNeoAskTrigger(ask, deps)).toBeFalsy();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].lines).toEqual(['question: Start? (options: Later / Start)']);
  });

  test('a failed transport retries the same fact-state delivery ID', async () => {
    const { deps, wakes, delivery, recorded } = sweepDeps(startRead);
    delivery.ok = false;
    await noteNeoAskTrigger(ask, deps);
    await settle();
    expect(recorded.size).toBe(0);
    delivery.ok = true;
    await noteNeoAskTrigger(ask, deps);
    await settle();
    expect(wakes.map((wake) => wake.triggerId)).toEqual([wakes[0].triggerId, wakes[0].triggerId]);
    expect(await noteNeoAskTrigger(ask, deps)).toBeFalsy();
    expect(wakes).toHaveLength(2);
  });

  test('a new action on the same ask is a new trigger with its own id', async () => {
    const read = {
      view: view({
        humanActions: [
          { kind: 'question', itemId: 'proposal', question: 'Start?', options: ['Later', 'Start'] },
        ],
      }),
      cards: [],
    };
    const { deps, wakes } = sweepDeps(read);
    await noteNeoAskTrigger(ask, deps);
    await settle();
    read.view = view({
      humanActions: [
        { kind: 'question', itemId: 'proposal', question: 'Start?', options: ['Later', 'Start'] },
        { kind: 'question', itemId: 'i3', question: 'Ship it?', options: ['Yes', 'No'] },
      ],
    });
    await noteNeoAskTrigger(ask, deps);
    expect(wakes.map((wake) => wake.keys)).toEqual([
      ['question:proposal'],
      ['question:proposal', 'question:i3'],
    ]);
    expect(wakes[1].lines).toContain('question: Ship it? (options: Yes / No)');
    expect(wakes[0].triggerId).not.toBe(wakes[1].triggerId);
  });

  test('waits while the session that owns the ask is busy', async () => {
    const { deps, wakes } = sweepDeps(startRead, true);
    expect(await noteNeoAskTrigger(ask, deps)).toBeFalsy();
    expect(wakes).toEqual([]);
  });
});

describe('neoTriggerNote', () => {
  test('states the trigger and its fact, with no command and no language', () => {
    const note = neoTriggerNote(ask, {
      triggerId: 'outcome:a1:x',
      kind: 'outcome',
      keys: ['outcome:0'],
      lines: ['the ask is achieved'],
    });
    expect(note).toMatch(
      /^Ask progress on ask a1 ".*": Recorded event: the ask reached its outcome\. /
    );
    expect(note).toContain('triggerId: "outcome:a1:x"');
    expect(JSON.parse(note.slice(note.indexOf('\n') + 1)).trigger).toEqual({
      id: 'outcome:a1:x',
      kind: 'outcome',
      state: ['the ask is achieved'],
    });
    expect(note).not.toMatch(/Tell the human|only message/);
    expect(note).not.toContain('language');
  });

  test('an idle trigger states that nothing runs', () => {
    const note = neoTriggerNote(ask, {
      triggerId: 'idle:a1:x',
      kind: 'idle',
      keys: ['idle:500'],
      lines: ['nothing is running'],
    });
    expect(note).toContain('nothing is running for the ask and its outcome is not met');
    expect(note).not.toContain('neo.ask.question');
    expect(note).not.toContain('settle');
    expect(note).not.toContain('failed');
  });
});

describe('NeoService notification triggers', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const mailbox = () =>
    (
      db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as {
        payload: string;
      }[]
    ).map((row) => JSON.parse(row.payload) as { messageUuid: string; message: unknown });
  const human = (messageId: string, text: string) => {
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: messageId,
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: text },
    } as unknown as SDKUserMessage);
    service.asks.append({
      conversationId,
      requestId: messageId,
      askOrigin: { sessionId: root, messageId },
      content: text,
    });
  };
  const open = () =>
    service.askRecords.open(
      {
        id: 'a1',
        requestKey: 'k1',
        projectId: null,
        originSessionId: root,
        originMessageId: m0,
        title: 'Fix the composer',
        ask: 'Fix the composer',
        doneWhen: '- composer fixed',
        doneSource: 'human',
      },
      [{ text: 'composer fixed', check: null }]
    )!;
  const tickMet = (opened: NeoAsk) =>
    service.askRecords.tickItem(
      opened.id,
      { id: opened.doneItems![0].id, state: 'met', evidence: 'merged', metBy: 'neo' },
      Date.now()
    );
  const sweep = () => (service as unknown as { sweepTriggers(): Promise<void> }).sweepTriggers();
  const initialize = () =>
    (service as unknown as { initializeTriggerFacts(): void }).initializeTriggerFacts();

  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession(root));
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    human(m0, '把输入框修好');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    db.close();
  });

  test('baselines historical settled asks once without waking them, and delivers later fact changes', async () => {
    const opened = open();
    tickMet(opened);
    service.askRecords.settle(service.askRecords.get(opened.id)!, 'achieved', 'Fixed.', 'merged');
    db.getDatabase()
      .prepare(`INSERT INTO neo_notification_triggers
        (ask_id, trigger_key, trigger_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(opened.id, 'outcome:1', 'outcome:a1:legacy', 1);
    const deliver = vi.spyOn(
      service as unknown as { deliver(...args: unknown[]): Promise<void> },
      'deliver'
    );
    initialize();
    await sweep();
    await sweep();
    expect(mailbox()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
    db.getDatabase()
      .prepare('UPDATE legacy_neo_asks SET revision = revision + 1 WHERE id = ?')
      .run(opened.id);
    initialize();
    await sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(mailbox()).toHaveLength(1);
  });

  test('startup leaves live asks eligible and records new settlements after the baseline', async () => {
    const opened = open();
    initialize();
    const deliver = vi.spyOn(
      service as unknown as { deliver(...args: unknown[]): Promise<void> },
      'deliver'
    );
    tickMet(opened);
    service.askRecords.settle(service.askRecords.get(opened.id)!, 'achieved', 'Fixed.', 'merged');
    initialize();
    await sweep();
    await sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(mailbox()).toHaveLength(1);
  });

  test('a published answer the hook never saw is applied by the next sweep, never a stale one', async () => {
    const opened = service.askRecords.open(
      {
        id: 'a1',
        requestKey: 'k1',
        projectId: null,
        originSessionId: root,
        originMessageId: m0,
        title: 'Count the files',
        ask: 'Count the files',
        doneWhen: '- the count',
        doneSource: 'human',
      },
      [{ text: 'the count', check: null, outcomeKind: 'answer' }]
    )!;
    service.askRecords.tickItem(
      opened.id,
      { id: 'i1', state: 'reported', evidence: '42 files', metBy: null },
      Date.now()
    );
    const internals = service as unknown as {
      triggers: { record(askId: string, keys: string[], triggerId: string, at: number): void };
    };
    internals.triggers.record('a1', ['outcome:0'], 'outcome:a1:stale', Date.now());
    service.publications.append({
      conversationId,
      publicationId: '40000000-0000-4000-8000-000000000002',
      askOrigin: { sessionId: root, messageId: m0 },
      producerInput: { sessionId: root, messageId: m0 },
      shortText: 'An older outcome.',
      fullText: 'An older outcome.',
      links: [],
      triggerId: 'outcome:a1:stale',
    });
    sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    const triggerId = mailbox()[0]
      .messageUuid.replace(/^neo-trigger:/, '')
      .replace(/#\d+$/, '');
    service.publications.append({
      conversationId,
      publicationId: '40000000-0000-4000-8000-000000000001',
      askOrigin: { sessionId: root, messageId: m0 },
      producerInput: { sessionId: root, messageId: m0 },
      shortText: '42 files.',
      fullText: '42 files.',
      links: [],
      triggerId,
    });
    expect(service.askRecords.get('a1')?.status).toBe('open');
    await sweep();
    expect(service.askRecords.get('a1')).toMatchObject({
      status: 'achieved',
      doneItems: [{ state: 'met', metBy: 'daemon' }],
    });
  });

  test('met items and recorded settlement are distinct facts, with stable IDs on repeat', async () => {
    const outcomes = () =>
      mailbox().filter((note) => note.messageUuid.startsWith('neo-trigger:outcome:'));
    const opened = open();
    sweep();
    expect(outcomes()).toEqual([]);
    tickMet(opened);
    sweep();
    await vi.waitFor(() => expect(outcomes()).toHaveLength(1));
    const [note] = outcomes();
    expect(note.messageUuid).toMatch(/^neo-trigger:outcome:a1:/);
    expect(JSON.stringify(note.message)).toContain('the ask reached its outcome');
    service.askRecords.settle(service.askRecords.get('a1')!, 'achieved', 'Fixed.', 'merged');
    sweep();
    sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcomes()).toHaveLength(2);
    expect(new Set(outcomes().map((item) => item.messageUuid)).size).toBe(2);
  });

  test('a root opener whose session row is gone is recreated for the note, not the holder', async () => {
    service.repo.saveProject({ id: 'labs', title: 'Labs', summary: '', context: '' }, 0);
    service.repo.reserveBinding({
      sessionId: 'neo:holder:labs',
      kind: 'project',
      projectId: 'labs',
    });
    const opened = service.askRecords.open(
      {
        id: 'a3',
        requestKey: 'k3',
        projectId: 'labs',
        originSessionId: root,
        originMessageId: m0,
        title: 'Fix the composer',
        ask: 'Fix the composer',
        doneWhen: '- composer fixed',
        doneSource: 'human',
      },
      [{ text: 'composer fixed', check: null }]
    )!;
    db.getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(root);
    const reopen = vi.spyOn(service, 'open').mockRejectedValue(new Error('not recreated in test'));
    tickMet(opened);
    await sweep();
    expect(reopen).toHaveBeenCalledWith(null);
    expect(reopen).not.toHaveBeenCalledWith('labs');
  });

  test('a note for an ask with no origin message is attributed to itself and keeps its trigger', async () => {
    const opened = service.askRecords.open(
      {
        id: 'a4',
        requestKey: 'k4',
        projectId: null,
        originSessionId: root,
        originMessageId: null,
        title: 'Fix the composer',
        ask: 'Fix the composer',
        doneWhen: '- composer fixed',
        doneSource: 'human',
      },
      [{ text: 'composer fixed', check: null }]
    )!;
    tickMet(opened);
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    const note = { sessionId: root, messageId: mailbox()[0].messageUuid };
    expect(service.inputTrigger(note)).toMatch(/^outcome:a4:/);
    expect(service.resolveAskOrigin(note)).toEqual(note);
  });

  test('a failed note delivery re-arms the sweep, and the retry sends it', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const opened = open();
    const rearm = vi.spyOn(
      service as unknown as { scheduleTriggerSweep(delay?: number): void },
      'scheduleTriggerSweep'
    );
    const deliver = vi
      .spyOn(service as unknown as { deliver(...args: unknown[]): Promise<void> }, 'deliver')
      .mockRejectedValueOnce(new Error('session gone'));
    tickMet(opened);
    rearm.mockClear();
    await sweep();
    expect(mailbox()).toEqual([]);
    expect(rearm).toHaveBeenCalledWith(NEO_TRIGGER_DELIVERY_RETRY_MS);
    await sweep();
    await sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    now += NEO_TRIGGER_DELIVERY_RETRY_MS;
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(mailbox()[0].messageUuid).toMatch(/^neo-trigger:outcome:a1:/);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  test('a missing project backs off opening while other sweeps still run', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const opened = open();
    tickMet(opened);
    const reopen = vi
      .spyOn(service, 'open')
      .mockRejectedValue(new Error('This project no longer exists.'));
    await sweep();
    now += NEO_TRIGGER_DELIVERY_RETRY_MS - 1;
    await sweep();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(mailbox()).toEqual([]);
    now += 1;
    await sweep();
    expect(reopen).toHaveBeenCalledTimes(2);
  });

  test('an outcome trigger recorded while a question was open is still found once it is answered', () => {
    const triggers = new NeoNotificationTriggerRepository(db.getDatabase());
    triggers.record('a1', ['outcome:2:q1'], 'outcome:a1:early', Date.now());
    triggers.record('a1', ['outcome:1'], 'outcome:a1:stale', Date.now());
    triggers.record('a1', ['idle:5'], 'idle:a1:x', Date.now());
    expect(triggers.triggerIdsFor('a1', 'outcome:2')).toEqual(['outcome:a1:early']);
  });

  test('a card proposed in a running turn raises no action note until that turn ends', async () => {
    const holder = 'neo:holder:labs';
    db.createSession(createTestSession(holder));
    const opened = open();
    db.updateSession(holder, {
      processingState: JSON.stringify({
        status: 'processing',
        messageId: 'turn',
        phase: 'streaming',
      }),
    });
    const work = service.repo.proposeWork({
      id: 'w-start',
      requestKey: 'w-start',
      projectId: null,
      originSessionId: holder,
      originMessageId: m0,
      title: 'Update the iMac',
      instruction: 'Update the iMac daemon.',
    });
    service.askRecords.link(opened.id, work.id);
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox()).toEqual([]);
    service.repo.transitionWork(work.id, work, { status: 'queued' });
    db.updateSession(holder, { processingState: JSON.stringify({ status: 'idle' }) });
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox().filter((note) => note.messageUuid.includes('action:'))).toEqual([]);
  });

  test('a session refusal wakes Neo with the recorded fact and no invented question', async () => {
    const opened = open();
    const work = service.repo.proposeWork({
      id: 'w-talk',
      requestKey: 'w-talk',
      projectId: null,
      originSessionId: root,
      originMessageId: m0,
      title: 'Update the iMac',
      instruction: 'Update the iMac daemon.',
    });
    service.askRecords.link(opened.id, work.id);
    service.repo.transitionWork(work.id, work, { status: 'queued' });
    service.workRefusals.record({
      workId: work.id,
      ref: 'session:daemon-code',
      what: 'update the iMac on Neo request',
      at: Date.now(),
    });
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(JSON.stringify(mailbox()[0].message)).toContain(
      'declined the instruction: update the iMac on Neo request'
    );
  });

  test('a consumed event without a publication is not another semantic attempt', async () => {
    const opened = open();
    tickMet(opened);
    await sweep();
    const [note] = mailbox();
    expect(note).toBeDefined();
    const reopen = vi.spyOn(service, 'open');
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: note.messageUuid,
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'system',
      message: { role: 'user', content: 'event facts' },
    } as unknown as SDKUserMessage);
    for (let n = 0; n < 5; n++) await sweep();
    expect(reopen).not.toHaveBeenCalled();
    expect(mailbox().map((item) => item.messageUuid)).toEqual([note.messageUuid]);
  });

  test('a note whose running turn then posts is never sent again', async () => {
    const opened = open();
    tickMet(opened);
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: mailbox()[0].messageUuid,
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'system',
      message: { role: 'user', content: 'note' },
    } as unknown as SDKUserMessage);
    const status = (service as unknown as { processingStatus: Map<string, string> })
      .processingStatus;
    status.set(root, 'processing');
    await sweep();
    service.publications.append({
      conversationId,
      publicationId: '20000000-0000-4000-8000-000000000009',
      askOrigin: { sessionId: root, messageId: m0 },
      producerInput: { sessionId: root, messageId: mailbox()[0].messageUuid },
      shortText: 'The composer is fixed.',
      fullText: 'The composer is fixed.',
      links: [],
      triggerId: mailbox()[0].messageUuid.slice('neo-trigger:'.length),
    });
    status.set(root, 'idle');
    await sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox()).toHaveLength(1);
  });

  test('a reply to one ask does not swallow a question that appeared on another', async () => {
    const opened = open();
    human(m1, 'something unrelated');
    service.askRecords.tickItem(
      opened.id,
      {
        id: opened.doneItems![0].id,
        state: 'needs_you',
        evidence: null,
        metBy: null,
        kind: 'decision',
        question: 'Ship now?',
        options: ['Yes', 'No'],
      },
      Date.now()
    );
    await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.publication.publish',
      withMintedPublicationId(service, {
        publicationId: '20000000-0000-4000-8000-000000000001',
        shortText: 'Here is the unrelated answer.',
        fullText: 'Here is the unrelated answer.',
        links: [],
      }),
      {
        source: 'mcp',
        sessionId: root,
        role: 'neo',
        neoTurn: { messageId: m1, human: true, isLive: () => true },
      }
    );
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(mailbox()[0].messageUuid).toMatch(/^neo-trigger:action:a1:/);
  });

  test('a human reply does not blanket-cover a newly recorded question', async () => {
    const opened = open();
    human(m1, 'ship it when ready');
    service.inputOrigins.record(
      { sessionId: root, messageId: m1 },
      { sessionId: root, messageId: m0 },
      0
    );
    service.askRecords.tickItem(
      opened.id,
      {
        id: opened.doneItems![0].id,
        state: 'needs_you',
        evidence: null,
        metBy: null,
        kind: 'decision',
        question: 'Ship now?',
        options: ['Yes', 'No'],
      },
      Date.now()
    );
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: root,
      role: 'neo',
      neoTurn: { messageId: m1, human: true, isLive: () => true },
    };
    expect(
      await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.publication.publish',
        withMintedPublicationId(service, {
          publicationId: '20000000-0000-4000-8000-000000000001',
          shortText: 'Ship now? Tap Yes or No.',
          fullText: 'Ship now? Tap Yes or No.',
          links: [],
        }),
        caller
      )
    ).toMatchObject({ value: { accepted: true } });
    sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox()).toHaveLength(1);
    expect(mailbox()[0].message.message.content).toContain('needs the human');
  });
});

describe('NeoNotificationTriggerRepository', () => {
  test('baseline initialization is atomic and persists across repository instances', async () => {
    const db = await createTestDb();
    try {
      const receipts = new NeoNotificationTriggerRepository(db.getDatabase());
      expect(() =>
        receipts.initializeFacts(() => {
          receipts.record('a1', ['outcome:1'], 'outcome:a1:baseline', 1);
          throw new Error('interrupted');
        }, 1)
      ).toThrow('interrupted');
      expect(receipts.trigger('outcome:a1:baseline')).toBeNull();
      receipts.initializeFacts(() => {
        receipts.record('a1', ['outcome:1'], 'outcome:a1:baseline', 2);
      }, 2);
      const later = new NeoNotificationTriggerRepository(db.getDatabase());
      later.initializeFacts(() => {
        later.record('a2', ['outcome:1'], 'outcome:a2:new', 3);
      }, 3);
      expect(later.trigger('outcome:a1:baseline')).toEqual({ askId: 'a1', keys: ['outcome:1'] });
      expect(later.trigger('outcome:a2:new')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('keeps overlapping event receipts and reads legacy keys', async () => {
    const db = await createTestDb();
    try {
      const receipts = new NeoNotificationTriggerRepository(db.getDatabase());
      receipts.record('a1', ['idle:1'], 'idle:a1:first', 1);
      receipts.record('a1', ['idle:1', 'answer:q1'], 'action:a1:next', 2);
      receipts.record('a1', ['answer:q1', 'idle:1'], 'action:a1:next', 3);
      receipts.record('a1', ['idle:1'], 'idle:a1:revised', 4);
      expect(receipts.trigger('idle:a1:revised')).toEqual({ askId: 'a1', keys: ['idle:1'] });
      expect(receipts.recorded('a1', 'idle:a1:revised')).toBe(true);
      expect(receipts.recorded('a2', 'idle:a1:revised')).toBe(false);
      expect(receipts.recorded('a1', 'idle:a1:missing')).toBe(false);
      expect(receipts.trigger('idle:a1:first')).toEqual({ askId: 'a1', keys: ['idle:1'] });
      expect(receipts.trigger('action:a1:next')).toEqual({
        askId: 'a1',
        keys: ['answer:q1', 'idle:1'],
      });
      db.getDatabase()
        .prepare(
          'INSERT INTO neo_notification_triggers (ask_id, trigger_key, trigger_id, created_at) VALUES (?, ?, ?, ?)'
        )
        .run('a1', 'outcome:2', 'outcome:a1:legacy', 0);
      expect(receipts.trigger('outcome:a1:legacy')).toEqual({ askId: 'a1', keys: ['outcome:2'] });
      expect(receipts.triggerIdsFor('a1', 'outcome:2')).toEqual(['outcome:a1:legacy']);
    } finally {
      db.close();
    }
  });
});
