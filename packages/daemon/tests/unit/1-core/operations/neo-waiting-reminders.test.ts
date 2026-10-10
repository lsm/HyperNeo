import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { NEO_WAITING_REMINDER } from '@hyperneo/prompts';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  neoWaitingOnHuman,
  planNeoWaitingReminders,
} from '../../../../src/lib/neo/waiting-reminders.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { NeoRoutingLogRepository } from '../../../../src/storage/repositories/neo-routing-log-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const ask: NeoAsk & { remindedAt: number | null } = {
  id: 'a1',
  requestKey: 'k1',
  concernId: null,
  originSessionId: root,
  originMessageId: 'm0',
  title: 'Voice composer design',
  ask: 'Design the voice composer',
  doneWhen: '',
  doneSource: 'human',
  status: 'waiting',
  outcome: 'Pick the bar position.',
  evidence: null,
  createdAt: 10,
  updatedAt: 100,
  settledAt: 100,
  workIds: [],
  doneItems: [],
  remindedAt: null,
};

describe('planNeoWaitingReminders', () => {
  test.each<[string, Partial<typeof ask>, number, boolean]>([
    ['an ask that went waiting before the message', {}, 200, true],
    ['an ask that went waiting while answering this message', { updatedAt: 250 }, 200, false],
    ['an ask already reminded since it went waiting', { remindedAt: 150 }, 200, false],
    ['an ask that changed after its last reminder', { remindedAt: 50 }, 200, true],
  ])('%s', (_label, overrides, askedAt, due) => {
    expect(planNeoWaitingReminders([{ ...ask, ...overrides }], askedAt)).toHaveLength(due ? 1 : 0);
  });
});

describe('neoWaitingOnHuman', () => {
  test.each<[string, NeoAsk[], ReturnType<typeof neoWaitingOnHuman>]>([
    ['no waiting asks', [], undefined],
    [
      'a waiting ask with its question',
      [ask],
      {
        note: NEO_WAITING_REMINDER,
        asks: [
          { id: 'a1', title: ask.title, status: 'waiting', question: 'Pick the bar position.' },
        ],
      },
    ],
    [
      'a blocked ask with no summary',
      [{ ...ask, status: 'blocked', outcome: null }],
      {
        note: NEO_WAITING_REMINDER,
        asks: [{ id: 'a1', title: ask.title, status: 'blocked', question: ask.title }],
      },
    ],
  ])('%s', (_label, asks, waiting) => {
    expect(neoWaitingOnHuman(asks)).toEqual(waiting);
  });
});

describe('Neo turns with an ask waiting on the human', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  const human = (messageId: string): OperationCaller => ({
    source: 'mcp',
    sessionId: root,
    role: 'neo',
    neoTurn: { messageId, human: true, isLive: () => true },
  });
  const writes = (messageId: string, askedAt: number) => {
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: messageId,
      session_id: root,
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'something else' },
    } as unknown as SDKUserMessage);
    new NeoRoutingLogRepository(db.getDatabase()).record({
      messageId,
      conversationId,
      askedAt,
      ask: 'something else',
      destination: 'main',
      targetSessionId: root,
      concernId: null,
      signal: 'opened',
      confidence: 1,
    });
  };

  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      { createSession: vi.fn(), getSessionAsync: vi.fn() } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    db.createSession(createTestSession(root));
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', concernId: null });
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  const invoke = (name: string, input: unknown, as: OperationCaller) =>
    invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, as);
  const waitingOn = async (as: OperationCaller) => {
    const outcome = await invoke('neo.snapshot', {}, as);
    return 'value' in outcome
      ? (outcome.value as { waitingOnHuman?: { asks: { id: string }[] } }).waitingOnHuman
      : outcome;
  };
  const reply = (messageId: string, publicationId: string, interim = false) =>
    invoke(
      'neo.publication.publish',
      {
        publicationId,
        shortText: 'Done.',
        fullText: 'Done.',
        links: [],
        ...(interim && { interim }),
      },
      human(messageId)
    );

  test('lists the ask on the next human message only, until it changes again', async () => {
    const { id, requestKey, originMessageId, title, doneWhen, doneSource } = ask;
    const opened = service.askRecords.open({
      id,
      requestKey,
      concernId: null,
      originSessionId: root,
      originMessageId,
      title,
      ask: ask.ask,
      doneWhen,
      doneSource,
    })!;
    const waiting = service.askRecords.settle(opened, 'waiting', 'Pick the bar position.', '')!;
    writes('ask-1', waiting.updatedAt + 1);

    expect(await waitingOn(human('ask-1'))).toMatchObject({
      note: NEO_WAITING_REMINDER,
      asks: [{ id: 'a1', question: 'Pick the bar position.' }],
    });
    expect(
      await waitingOn({
        ...human('w1:done-check:0'),
        neoTurn: { ...human('x').neoTurn!, messageId: 'w1:done-check:0', human: false },
      })
    ).toBeUndefined();

    expect(await reply('ask-1', '20000000-0000-4000-8000-000000000001', true)).toMatchObject({
      value: { accepted: true },
    });
    expect(await waitingOn(human('ask-1'))).toBeDefined();
    expect(await reply('ask-1', '20000000-0000-4000-8000-000000000002')).toMatchObject({
      value: { accepted: true, created: true },
    });
    writes('ask-2', waiting.updatedAt + 2);
    expect(await waitingOn(human('ask-2'))).toBeUndefined();

    const asked = service.askRecords.settle(waiting, 'waiting', 'Approve the bar position?', '')!;
    writes('ask-3', asked.updatedAt + 1);
    expect(await waitingOn(human('ask-3'))).toMatchObject({
      asks: [{ id: 'a1', question: 'Approve the bar position?' }],
    });
  });
});
