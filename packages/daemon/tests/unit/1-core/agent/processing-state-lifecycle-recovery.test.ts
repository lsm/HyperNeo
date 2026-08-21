import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { PendingUserQuestion, Session, MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';

const sessionId = 'recovery-session';

describe('chat/thread lifecycle recovery — stale waiting_for_input', () => {
  let manager: ProcessingStateManager;
  let handler: SDKMessageHandler;
  let stored: { processingState?: string } | null;
  let db: Database;
  let internalEventBus: InternalEventBus<any>;

  beforeEach(() => {
    stored = null;
    const updateSession = mock((_id: string, patch: Record<string, unknown>) => {
      stored = { ...(stored ?? {}), ...patch } as { processingState?: string };
    });
    db = {
      getSession: mock(() => stored),
      updateSession,
      saveSDKMessage: mock(() => true),
      getMessageByStatusAndUuid: mock(() => null),
      updateMessageStatus: mock(() => {}),
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
    } as unknown as Database;

    const emit = mock(async () => {});
    internalEventBus = {
      publish: emit,
      publishAsync: emit,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    manager = new ProcessingStateManager(sessionId, internalEventBus, db);

    const session = {
      id: sessionId,
      title: 'Recovery',
      workspacePath: '/test',
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    } as unknown as Session;

    const messageHub = {
      event: mock(async () => {}),
      onRequest: mock((_m: string, _h: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;
    const daemonHub = { emit } as unknown as DaemonHub;
    const contextTracker = {
      getContextInfo: () => ({ totalTokens: 0, maxTokens: 128000 }),
      updateWithDetailedBreakdown: () => {},
      shouldCompact: () => false,
      shouldCompactAt: () => false,
      markCompactionTriggered: () => {},
    } as unknown as ContextTracker;
    const messageQueue = {
      enqueue: mock(async () => 'ctx-id'),
      enqueueWithId: mock(async () => {}),
      clear: mock(() => {}),
    } as unknown as MessageQueue;
    const errorManager = { handleError: mock(async () => {}) } as unknown as ErrorManager;
    const lifecycleManager = { stop: mock(async () => {}) } as unknown as QueryLifecycleManager;

    handler = new SDKMessageHandler({
      session,
      db,
      messageHub,
      daemonHub,
      internalEventBus,
      stateManager: manager,
      contextTracker,
      messageQueue,
      errorManager,
      lifecycleManager,
      queryObject: null,
      queryPromise: null,
      onInitSlashCommands: mock(async () => {}),
      onCommandsChanged: mock(async () => {}),
    });
  });

  test('a terminal result delivered through SDKMessageHandler clears a stale waiting_for_input restored after restart', async () => {
    const pendingQuestion: PendingUserQuestion = { toolUseId: 'stale-question', questions: [] };
    stored = { processingState: JSON.stringify({ status: 'waiting_for_input', pendingQuestion }) };

    manager.restoreFromDatabase();
    expect(manager.isWaitingForInput()).toBe(true);
    expect(manager.getPendingQuestion()?.toolUseId).toBe('stale-question');

    const result: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      uuid: 'terminal-error-result',
      total_cost_usd: 0,
      modelUsage: {},
    } as unknown as SDKMessage;
    await handler.handleMessage(result);

    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
    expect(manager.getPendingQuestion()).toBeNull();

    expect(stored?.processingState).toContain('"status":"idle"');
    const restarted = new ProcessingStateManager(sessionId, internalEventBus, db);
    restarted.restoreFromDatabase();
    expect(restarted.isIdle()).toBe(true);
    expect(restarted.isWaitingForInput()).toBe(false);
    expect(restarted.getPendingQuestion()).toBeNull();
  });

  test('an interrupted processing turn recovers to idle on restart (not waiting_for_input)', () => {
    stored = {
      processingState: JSON.stringify({ status: 'processing', phase: 'streaming' }),
    };

    manager.restoreFromDatabase();
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
  });
});
