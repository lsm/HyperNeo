/**
 * Chat/Thread Lifecycle Recovery — stale waiting_for_input on the daemon.
 *
 * Regression coverage for scenario 5 (terminal result arrival after stale
 * waiting_for_input). The recovery invariant spans two collaborators:
 *
 *   1. ProcessingStateManager.restoreFromDatabase() preserves a
 *      waiting_for_input state (and its pendingQuestion) across a restart,
 *      while resetting processing/queued/cooldown to idle.
 *   2. The terminal-result path inside SDKMessageHandler —
 *      `if (isSDKResultMessage(message) && !usesSessionStateChangedTurnEnd)
 *      await stateManager.setIdle()` — clears that stale question before
 *      type-specific handling so an interrupted AskUserQuestion turn cannot
 *      keep the composer locked.
 *
 * To actually protect invariant (2), these tests wire a REAL
 * ProcessingStateManager as the handler's state manager and deliver a
 * terminal result message through SDKMessageHandler.handleMessage() — NOT
 * by calling setIdle() directly. detectPhaseFromMessage() early-returns
 * while not processing, so the only thing that can release the stale lock
 * on a result is the handler's terminal-result setIdle() call.
 */

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
  // In-memory stand-in for the persisted session row. updateSession mutates
  // it so restoreFromDatabase reflects what a restart would observe.
  let stored: { processingState?: string } | null;

  beforeEach(() => {
    stored = null;
    const updateSession = mock((_id: string, patch: Record<string, unknown>) => {
      stored = { ...(stored ?? {}), ...patch } as { processingState?: string };
    });
    const db = {
      getSession: mock(() => stored),
      updateSession,
      saveSDKMessage: mock(() => true),
      getMessagesByStatus: mock(() => []),
      getMessageByStatusAndUuid: mock(() => null),
      updateMessageStatus: mock(() => {}),
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
    } as unknown as Database;

    const emit = mock(async () => {});
    const internalEventBus = {
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
    // 1. A crash left the session persisted in waiting_for_input.
    stored = { processingState: JSON.stringify({ status: 'waiting_for_input', pendingQuestion }) };

    // 2. Restart: the waiting state and its pending question are restored,
    //    so the UI can still surface the unanswered prompt.
    manager.restoreFromDatabase();
    expect(manager.isWaitingForInput()).toBe(true);
    expect(manager.getPendingQuestion()?.toolUseId).toBe('stale-question');

    // 3. Deliver a terminal ERROR result through the real handler. An error
    //    result is isSDKResultMessage but NOT isSDKResultSuccess, so it runs
    //    the handler's stale-clear at the top of the result path but never
    //    reaches handleResultMessage()/finishTurn() (which would also call
    //    setIdle for a success result). This isolates the fixed path: if the
    //    "clear stale waiting_for_input on result" setIdle() is removed or
    //    reordered, this assertion fails.
    const result: SDKMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      uuid: 'terminal-error-result',
      total_cost_usd: 0,
      modelUsage: {},
    } as unknown as SDKMessage;
    await handler.handleMessage(result);

    // 4. The stale lock is released: composer unlocks, no lingering question.
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
    expect(manager.getPendingQuestion()).toBeNull();
  });

  test('an interrupted processing turn recovers to idle on restart (not waiting_for_input)', () => {
    // Contrast spine: although waiting_for_input is preserved across restart,
    // a session that crashed mid-processing must come back idle so it is not
    // stuck — only a deliberate waiting_for_input is restored as-is.
    stored = {
      processingState: JSON.stringify({ status: 'processing', phase: 'streaming' }),
    };

    manager.restoreFromDatabase();
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
  });
});
