import { withMintedPublicationId } from '../../../helpers/neo-minted-publication.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoAsk, NeoAskView, NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  coverNeoAskTriggers,
  isNeoAskAnsweredByReply,
  isNeoCardFailedForGood,
  neoReplyOriginKey,
  neoAskTriggerConcern,
  neoTriggerMessageId,
  shouldPreemptNeoTurn,
  planNeoTriggerRetry,
  neoTriggerRetryStatuses,
  requireNeoTriggerUnheard,
  shouldRetryNeoTrigger,
  isNeoHumanOwnTurn,
  NEO_TRIGGER_RETRY_MS,
  neoAskTriggerKeys,
  neoTriggerNote,
  noteNeoAskTrigger,
  planNeoAskTrigger,
  type NeoAskTrigger,
  type NeoTriggerSweepDeps,
} from '../../../../src/lib/neo/notification-triggers.ts';
import { neoCardGroup } from '../../../../src/lib/neo/card-phase.ts';
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
const work = (id: string) => ({ id, title: `Card ${id}`, updatedAt: 500 });
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
  const trigger = (id: string) => (id === 'system' ? null : `human:${id}`);
  const answered = (value: string) => value === 'human:old';

  test('preempts only a processing turn whose trigger already has its answer', () => {
    expect(shouldPreemptNeoTurn(state('processing', 'old'), trigger, answered)).toBe(true);
    expect(shouldPreemptNeoTurn(state('processing', 'fresh'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(state('processing', 'system'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(state('idle'), trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn(undefined, trigger, answered)).toBe(false);
    expect(shouldPreemptNeoTurn('not json', trigger, answered)).toBe(false);
  });
});

describe('trigger keys of an ask', () => {
  const keys = (target: NeoAsk, read = { view: view(), cards: [card()] }, pending = false) =>
    neoAskTriggerKeys(target, read, work, () => pending).map((key) => [key.kind, key.key]);

  test('an ask with nothing running wakes Neo once per ended card', () => {
    const idle = {
      view: view({ workIds: [], idle: true, humanActions: [{ kind: 'drop' }] }),
      cards: [card({ phase: 'cancelled' })],
    };
    expect(keys(ask, idle)).toEqual([['idle', 'idle:500']]);
    expect(keys({ ...ask, workIds: [] }, idle)).toEqual([['idle', 'idle:10']]);
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
          { kind: 'start', workId: 'w1' },
          {
            kind: 'answer',
            itemId: 'i3',
            step: null,
            question: 'Ship it?',
            options: ['Yes', 'No'],
          },
          { kind: 'talk', workId: 'w1', what: 'update the iMac' },
        ],
      }),
      cards: [card()],
    };
    expect(keys(ask, read)).toEqual([
      ['action', 'start:w1'],
      ['action', 'answer:i3'],
      ['action', 'talk:w1:update the iMac'],
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
    const read = { view: view({ humanActions: [{ kind: 'close', workId: 'w1' }] }), cards: [] };
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

describe('neoTriggerRetryStatuses', () => {
  test('attempts count only at the opener; the old holder only shows whether its note ended', () => {
    expect(neoTriggerRetryStatuses(['consumed'], ['consumed', 'consumed', 'consumed'])).toEqual([
      'consumed',
    ]);
    expect(neoTriggerRetryStatuses([], ['consumed', 'consumed', 'consumed'])).toEqual(['consumed']);
    expect(neoTriggerRetryStatuses([], ['consumed', 'enqueued'])).toEqual(['pending']);
    expect(neoTriggerRetryStatuses([], [])).toEqual([]);
  });
});

describe('isNeoHumanOwnTurn', () => {
  test('the human message and its turn-limit continuations are the human’s own turn', () => {
    expect(isNeoHumanOwnTurn('m1', 'human:m1')).toBe(true);
    expect(isNeoHumanOwnTurn('neo-turn-limit:r1', 'human:m1')).toBe(true);
    expect(isNeoHumanOwnTurn('neo-nudge:m1', 'human:m1')).toBe(false);
    expect(isNeoHumanOwnTurn('neo-consult:c1:request', 'human:m1')).toBe(false);
    expect(isNeoHumanOwnTurn('neo-turn-limit:r1', 'idle:a1:x')).toBe(false);
    expect(isNeoHumanOwnTurn('m1', null)).toBe(false);
  });
});

describe('planNeoTriggerRetry', () => {
  test.each([
    [true, ['consumed'], 'done'],
    [false, [], 'wait'],
    [false, ['enqueued'], 'wait'],
    [false, ['consumed'], 'retry'],
    [false, ['consumed', 'failed'], 'retry'],
    [false, ['consumed', 'consumed', 'consumed'], 'done'],
  ] as const)('published %s with note statuses %j is %s', (published, statuses, plan) => {
    expect(planNeoTriggerRetry(published, statuses)).toBe(plan);
  });
});

describe('neoTriggerMessageId', () => {
  test('a retried note keeps its trigger id', () => {
    expect(neoTriggerMessageId('outcome:a1:x', 1)).toBe('neo-trigger:outcome:a1:x#2');
  });
});

describe('isNeoAskAnsweredByReply', () => {
  test('a reply covers only the ask it answered', () => {
    const covers = new Set([neoReplyOriginKey({ sessionId: root, messageId: 'm0' })]);
    expect(isNeoAskAnsweredByReply(ask, covers)).toBe(true);
    expect(isNeoAskAnsweredByReply({ ...ask, originMessageId: 'other' }, covers)).toBe(false);
    expect(isNeoAskAnsweredByReply({ ...ask, originMessageId: null }, covers)).toBe(false);
  });
});

describe('planNeoAskTrigger', () => {
  const key = (kind: 'outcome' | 'failed' | 'action', name: string) => ({
    kind,
    key: name,
    line: name,
  });

  test('names the most important new kind, with an id stable for the same transition', () => {
    const keys = [key('action', 'start:w1'), key('failed', 'failed:w2:1')];
    const id = (planned: ReturnType<typeof planNeoAskTrigger>) =>
      'value' in planned ? planned.value.triggerId : null;
    const first = planNeoAskTrigger(ask, keys, new Set());
    expect(first).toMatchObject({ value: { kind: 'failed', keys: ['start:w1', 'failed:w2:1'] } });
    expect(id(planNeoAskTrigger(ask, [...keys].reverse(), new Set()))).toBe(id(first));
    expect(id(first)).toMatch(/^failed:a1:/);
  });

  test('a transition already told plans nothing', () => {
    expect(planNeoAskTrigger(ask, [key('action', 'start:w1')], new Set(['start:w1']))).toEqual({
      reason: null,
    });
  });
});

describe('noteNeoAskTrigger', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function sweepDeps(read: { view: NeoAskView; cards: NeoCardView[] }, busy = false) {
    const told = new Map<string, Set<string>>();
    const wakes: NeoAskTrigger[] = [];
    const delivery = { ok: true };
    const deps: NeoTriggerSweepDeps = {
      busy: () => busy,
      read: () => read,
      work,
      deliveryRetryPending: () => false,
      told: (askId) => new Set(told.get(askId)),
      heard: () => false,
      record: (askId, keys) => told.set(askId, new Set([...(told.get(askId) ?? []), ...keys])),
      wake: async (_ask, trigger) => {
        wakes.push(trigger);
        return delivery.ok;
      },
    };
    return { deps, wakes, delivery };
  }
  const startRead = { view: view({ humanActions: [{ kind: 'start', workId: 'w1' }] }), cards: [] };

  test('wakes Neo once per transition: a repeated sweep of the same state never wakes again', async () => {
    const { deps, wakes } = sweepDeps(startRead);
    expect(await noteNeoAskTrigger(ask, deps)).toMatchObject({
      kind: 'action',
      keys: ['start:w1'],
    });
    await settle();
    expect(await noteNeoAskTrigger(ask, deps)).toBeNull();
    expect(await noteNeoAskTrigger(ask, deps)).toBeNull();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].lines).toEqual(['card "Card w1" waits for Start']);
  });

  test('a note that fails to deliver stays untold, and the next sweep sends it again', async () => {
    const { deps, wakes, delivery } = sweepDeps(startRead);
    delivery.ok = false;
    await noteNeoAskTrigger(ask, deps);
    await settle();
    expect(deps.told(ask.id).size).toBe(0);
    delivery.ok = true;
    await noteNeoAskTrigger(ask, deps);
    await settle();
    expect(wakes.map((wake) => wake.triggerId)).toEqual([wakes[0].triggerId, wakes[0].triggerId]);
    expect(await noteNeoAskTrigger(ask, deps)).toBeNull();
  });

  test('a new action on the same ask is a new trigger with its own id', async () => {
    const read = { view: view({ humanActions: [{ kind: 'start', workId: 'w1' }] }), cards: [] };
    const { deps, wakes } = sweepDeps(read);
    await noteNeoAskTrigger(ask, deps);
    await settle();
    read.view = view({
      humanActions: [
        { kind: 'start', workId: 'w1' },
        { kind: 'answer', itemId: 'i3', step: null, question: 'Ship it?', options: ['Yes', 'No'] },
      ],
    });
    await noteNeoAskTrigger(ask, deps);
    expect(wakes.map((wake) => wake.keys)).toEqual([['start:w1'], ['answer:i3']]);
    expect(wakes[1].lines).toContain('question: Ship it? (options: Yes / No)');
    expect(wakes[0].triggerId).not.toBe(wakes[1].triggerId);
  });

  test('waits while the session that owns the ask is busy', async () => {
    const { deps, wakes } = sweepDeps(startRead, true);
    expect(await noteNeoAskTrigger(ask, deps)).toBeFalsy();
    expect(wakes).toEqual([]);
  });

  test('a human reply covers what it answered, so no trigger note follows it', async () => {
    const { deps, wakes } = sweepDeps(startRead);
    expect(coverNeoAskTriggers(ask, deps, ['action', 'outcome'])).toEqual(['start:w1']);
    expect(await noteNeoAskTrigger(ask, deps)).toBeNull();
    expect(wakes).toEqual([]);
  });
});

describe('neoTriggerNote', () => {
  test('names the trigger and what to tell the human, leaving the language to the turn', () => {
    const note = neoTriggerNote(ask, {
      triggerId: 'outcome:a1:x',
      kind: 'outcome',
      keys: ['outcome:0'],
      lines: ['the ask is achieved'],
    });
    expect(note).toContain('Notification trigger outcome:a1:x: the ask reached its outcome');
    expect(note).toContain('triggerId: "outcome:a1:x"');
    expect(note).toContain('- the ask is achieved');
    expect(note).toContain('name the outcome.');
    expect(note).not.toContain('language');
  });

  test('an idle trigger asks Neo to restart or settle, never to report a failure', () => {
    const note = neoTriggerNote(ask, {
      triggerId: 'idle:a1:x',
      kind: 'idle',
      keys: ['idle:500'],
      lines: ['nothing is running'],
    });
    expect(note).toContain('nothing is running for the ask and its outcome is not met');
    expect(note).toContain('propose new work for it or settle it');
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
  const seed = () => (service as unknown as { seedTriggers(): void }).seedTriggers();

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
    seed();
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

  test('every item met wakes Neo with a note naming the outcome trigger, once per transition', async () => {
    const opened = open();
    seed();
    sweep();
    expect(mailbox()).toEqual([]);
    tickMet(opened);
    sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    const [note] = mailbox();
    expect(note.messageUuid).toMatch(/^neo-trigger:outcome:a1:/);
    expect(JSON.stringify(note.message)).toContain('the ask reached its outcome');
    service.askRecords.settle(service.askRecords.get('a1')!, 'achieved', 'Fixed.', 'merged');
    sweep();
    sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox()).toHaveLength(1);
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
    seed();
    db.getDatabase().prepare('DELETE FROM sessions WHERE id = ?').run(root);
    const reopen = vi.spyOn(service, 'open').mockRejectedValue(new Error('not recreated in test'));
    tickMet(opened);
    await sweep();
    expect(reopen).toHaveBeenCalledWith(null);
    expect(reopen).not.toHaveBeenCalledWith('labs');
  });

  test('a failed note delivery re-arms the sweep, and the retry sends it', async () => {
    const opened = open();
    seed();
    const rearm = vi.spyOn(
      service as unknown as { scheduleTriggerSweep(delay?: number): void },
      'scheduleTriggerSweep'
    );
    vi.spyOn(
      service as unknown as { deliver(...args: unknown[]): Promise<void> },
      'deliver'
    ).mockRejectedValueOnce(new Error('session gone'));
    tickMet(opened);
    rearm.mockClear();
    await sweep();
    expect(mailbox()).toEqual([]);
    expect(rearm).toHaveBeenCalledWith(NEO_TRIGGER_RETRY_MS);
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(mailbox()[0].messageUuid).toMatch(/^neo-trigger:outcome:a1:/);
  });

  test('seeding at startup marks what is already there as told, without waking Neo', async () => {
    tickMet(open());
    seed();
    sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mailbox()).toEqual([]);
    expect(new NeoNotificationTriggerRepository(db.getDatabase()).isSeeded()).toBe(true);
  });

  test('a delivered note that ends without a post is sent again under the same trigger', async () => {
    const opened = open();
    seed();
    tickMet(opened);
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    const first = mailbox()[0].messageUuid;
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: first,
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'system',
      message: { role: 'user', content: 'note' },
    } as unknown as SDKUserMessage);
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(2));
    expect(mailbox()[1].messageUuid).toBe(`${first}#2`);
  });

  test('a note an older release spent every attempt on at the holder is still retried to the opener', async () => {
    const holder = 'neo:holder:labs';
    db.createSession(createTestSession(holder));
    service.repo.saveProject({ id: 'labs', title: 'Labs', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: 'labs' });
    const opened = service.askRecords.open(
      {
        id: 'a2',
        requestKey: 'k2',
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
    seed();
    const sent = vi
      .spyOn(service as unknown as { deliver(...args: unknown[]): Promise<void> }, 'deliver')
      .mockResolvedValueOnce(undefined);
    tickMet(opened);
    await sweep();
    const legacy = sent.mock.calls[0][1] as string;
    for (const uuid of [legacy, `${legacy}#2`, `${legacy}#3`])
      db.getSDKMessageRepo().saveSDKMessage(holder, {
        type: 'user',
        uuid,
        session_id: holder,
        parent_tool_use_id: null,
        inputKind: 'system',
        message: { role: 'user', content: 'note' },
      } as unknown as SDKUserMessage);
    sent.mockRestore();
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(JSON.stringify(mailbox()[0])).toContain(encodeURIComponent(root));
  });

  test('a session that refused the card wakes Neo with a talk trigger', async () => {
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
    seed();
    service.workRefusals.record({
      workId: work.id,
      ref: 'session:daemon-code',
      what: 'update the iMac on Neo request',
      at: Date.now(),
    });
    await sweep();
    await vi.waitFor(() => expect(mailbox()).toHaveLength(1));
    expect(JSON.stringify(mailbox()[0].message)).toContain(
      'needs the human to tell it directly: update the iMac on Neo request'
    );
  });

  test('a note whose running turn then posts is never sent again', async () => {
    const opened = open();
    seed();
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
    seed();
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

  test('the human reply that covers an ask’s new question leaves no trigger note behind', async () => {
    seed();
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
    expect(mailbox()).toEqual([]);
  });
});

describe('requireNeoTriggerUnheard', () => {
  const trigger = (kind: 'outcome' | 'idle') => ({
    triggerId: `${kind}:a1:x`,
    kind,
    keys: [`${kind}:1`],
    lines: [],
  });
  test('an outcome the human already heard is covered, not delivered', () => {
    const recorded: unknown[] = [];
    const deps = { heard: () => true, record: (...args: unknown[]) => recorded.push(args) };
    expect(requireNeoTriggerUnheard({ id: 'a1' } as never, trigger('outcome'), deps)).toEqual({
      reason: null,
    });
    expect(recorded).toEqual([['a1', ['outcome:1'], null]]);
    expect(requireNeoTriggerUnheard({ id: 'a1' } as never, trigger('idle'), deps)).toMatchObject({
      value: { kind: 'idle' },
    });
  });
});

describe('shouldRetryNeoTrigger', () => {
  test.each([
    ['open', 'idle', false, true],
    ['achieved', 'idle', false, false],
    ['abandoned', 'action', false, false],
    ['achieved', 'outcome', false, true],
    ['achieved', 'outcome', true, false],
  ] as const)('ask %s, %s trigger, heard %s: retry %s', (status, kind, heard, retry) => {
    expect(shouldRetryNeoTrigger({ status }, kind, heard)).toBe(retry);
  });
});
