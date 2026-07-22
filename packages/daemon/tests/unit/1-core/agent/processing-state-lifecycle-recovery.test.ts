/**
 * Chat/Thread Lifecycle Recovery — stale waiting_for_input on the daemon.
 *
 * Regression coverage for scenario 5 (terminal result arrival after stale
 * waiting_for_input). The authoritative recovery invariant spans two
 * collaborators that the existing unit suite tests only in isolation:
 *
 *   1. ProcessingStateManager.restoreFromDatabase() preserves a
 *      waiting_for_input state (and its pendingQuestion) across a restart,
 *      while resetting processing/queued/cooldown to idle.
 *   2. The terminal-result path (SDKMessageHandler calls stateManager.setIdle()
 *      before type-specific handling) clears that stale question so the
 *      composer cannot stay locked after an interrupted AskUserQuestion turn.
 *
 * This file exercises the combined flow against a real ProcessingStateManager
 * — persist waiting_for_input -> restart restores it -> terminal result clears
 * it -> the cleared state is persisted so a second restart does not re-lock.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { PendingUserQuestion } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

const sessionId = 'recovery-session';

describe('chat/thread lifecycle recovery — stale waiting_for_input', () => {
  let manager: ProcessingStateManager;
  // In-memory stand-in for the persisted session row. updateSession mutates
  // it so we can assert what a subsequent restart would observe.
  let stored: { processingState?: string } | null;

  beforeEach(() => {
    stored = null;
    const updateSessionMock = mock((_id: string, patch: Record<string, unknown>) => {
      stored = { ...(stored ?? {}), ...patch } as { processingState?: string };
    });
    const mockDb = {
      getSession: mock(() => stored),
      updateSession: updateSessionMock,
    } as unknown as Database;
    const mockInternalEventBus = {
      publish: mock(() => {}),
      publishAsync: mock(async () => {}),
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;

    manager = new ProcessingStateManager(sessionId, mockInternalEventBus, mockDb);
  });

  test('waiting_for_input survives a restart and is cleared when the terminal-result path runs', async () => {
    const pendingQuestion: PendingUserQuestion = {
      toolUseId: 'stale-question',
      questions: [],
    };

    // 1. A crash left the session persisted in waiting_for_input.
    stored = { processingState: JSON.stringify({ status: 'waiting_for_input', pendingQuestion }) };

    // 2. Restart: the waiting state and its pending question are restored,
    //    so the UI can still surface the unanswered prompt.
    manager.restoreFromDatabase();
    expect(manager.isWaitingForInput()).toBe(true);
    expect(manager.getPendingQuestion()?.toolUseId).toBe('stale-question');

    // 3. The terminal-result path runs (SDKMessageHandler.setIdle() before
    //    type-specific handling) and must release the stale lock.
    await manager.setIdle();
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
    expect(manager.getPendingQuestion()).toBeNull();

    // 4. The cleared state was persisted — a second restart must NOT re-lock
    //    the composer in waiting_for_input.
    expect(stored?.processingState).toContain('"status":"idle"');
    manager.restoreFromDatabase();
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
  });

  test('an interrupted AskUserQuestion turn recovers to idle on restart (not waiting_for_input)', () => {
    // Contrast spine: even though waiting_for_input is preserved, a session
    // that crashed mid-processing must come back idle so it is not stuck.
    stored = {
      processingState: JSON.stringify({ status: 'processing', phase: 'streaming' }),
    };

    manager.restoreFromDatabase();
    expect(manager.isIdle()).toBe(true);
    expect(manager.isWaitingForInput()).toBe(false);
  });
});
