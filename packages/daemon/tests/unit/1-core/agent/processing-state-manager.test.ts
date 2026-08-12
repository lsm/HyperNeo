/**
 * ProcessingStateManager Tests
 *
 * Tests for agent processing state machine including:
 * - State transitions (idle -> queued -> processing -> idle)
 * - Streaming phase tracking
 * - Database persistence
 * - Event emission
 * - State restoration after restart
 * - Question/answer handling
 * - Compacting state tracking
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { SDKMessage } from '@hyperneo/shared/sdk';

describe('ProcessingStateManager', () => {
  let manager: ProcessingStateManager;
  let mockDb: Database;
  let mockInternalEventBus: InternalEventBus<any>;
  let updateSessionMock: ReturnType<typeof mock>;
  let emitMock: ReturnType<typeof mock>;
  const sessionId = 'test-session-id';

  function createMockDb(): Database {
    return {
      getSession: mock(() => null),
      updateSession: updateSessionMock,
    } as unknown as Database;
  }

  function createMockInternalEventBus(): InternalEventBus<any> {
    return {
      publish: emitMock,
      publishAsync: emitMock,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
  }

  beforeEach(() => {
    updateSessionMock = mock(() => {});
    emitMock = mock(async () => {});
    mockDb = createMockDb();
    mockInternalEventBus = createMockInternalEventBus();
    manager = new ProcessingStateManager(sessionId, mockInternalEventBus, mockDb);
  });

  describe('initialization', () => {
    test('starts with idle state', () => {
      const state = manager.getState();
      expect(state.status).toBe('idle');
    });

    test('isIdle returns true initially', () => {
      expect(manager.isIdle()).toBe(true);
    });

    test('isProcessing returns false initially', () => {
      expect(manager.isProcessing()).toBe(false);
    });

    test('isWaitingForInput returns false initially', () => {
      expect(manager.isWaitingForInput()).toBe(false);
    });

    test('getIsCompacting returns false initially', () => {
      expect(manager.getIsCompacting()).toBe(false);
    });
  });

  describe('setIdle', () => {
    test('transitions to idle state', async () => {
      await manager.setIdle();

      const state = manager.getState();
      expect(state.status).toBe('idle');
      expect(manager.isIdle()).toBe(true);
    });

    test('persists state to database', async () => {
      await manager.setIdle();

      expect(updateSessionMock).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          processingState: expect.any(String),
        })
      );

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('idle');
    });

    test('emits session.updated event', async () => {
      await manager.setIdle();

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: expect.objectContaining({ status: 'idle' }),
        })
      );
    });

    test('resets streaming phase tracking', async () => {
      // First set to processing
      await manager.setProcessing('msg-1', 'streaming');

      // Then back to idle
      await manager.setIdle();

      // Check internal state was reset
      expect(manager.getIsCompacting()).toBe(false);
    });

    test('executes onIdleCallback when set', async () => {
      const callbackMock = mock(async () => {});
      manager.setOnIdleCallback(callbackMock);

      await manager.setIdle();

      expect(callbackMock).toHaveBeenCalled();
    });

    test('handles callback errors gracefully', async () => {
      const callbackMock = mock(async () => {
        throw new Error('Callback error');
      });
      manager.setOnIdleCallback(callbackMock);

      // Should not throw
      await manager.setIdle();

      expect(callbackMock).toHaveBeenCalled();
    });

    test('waiter onEnd fires BEFORE the waiter promise resolves on a terminal idle', async () => {
      // The delivery-turn completion marker must be persisted before the delivery
      // job (`await turn`) resolves on the idle drain — a crash after idle but
      // before the write would otherwise re-drive a result-less consumed turn.
      // See Codex (PR #2463, P2).
      const events: string[] = [];
      const waiter = manager.waitForIdleTransition(undefined, () => events.push('onEnd'));
      void waiter.promise.then(() => events.push('waiter-resolved'));
      await manager.setIdle();
      await waiter.promise;
      expect(events).toEqual(['onEnd', 'waiter-resolved']);
    });

    test('waiter onEnd (marker) fires BEFORE the awaited idle side effects (P2)', async () => {
      // The durable marker must be persisted synchronously at the START of
      // setIdle — before the session.updated publish and the deferred-restart
      // callback — so a crash after the idle-state DB write can't lose it.
      // The waiter promise (job completion) stays deferred until the finally.
      const events: string[] = [];
      let resolveCallback!: () => void;
      manager.setOnIdleCallback(
        () =>
          new Promise<void>((r) => {
            resolveCallback = r;
          })
      );
      const waiter = manager.waitForIdleTransition(undefined, () => events.push('onEnd'));
      void waiter.promise.then(() => events.push('waiter-resolved'));
      const setIdlePromise = manager.setIdle();
      // onEnd fires synchronously (before setIdle's first await); the waiter
      // does NOT resolve until the finally (after the deferred callback).
      expect(events).toEqual(['onEnd']);
      expect(events).not.toContain('waiter-resolved');
      // Flush microtasks so setState's publish resolves and onIdleCallback is
      // invoked (now awaiting our resolver) — still before the finally drain.
      await new Promise((r) => setTimeout(r, 0));
      expect(typeof resolveCallback).toBe('function');
      expect(events).not.toContain('waiter-resolved');
      resolveCallback();
      await setIdlePromise;
      await waiter.promise;
      expect(events).toEqual(['onEnd', 'waiter-resolved']);
    });

    test('late waiter armed during terminal idle fires onEnd before resolving', async () => {
      const events: string[] = [];
      let resolvePublish!: () => void;
      emitMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePublish = resolve;
          })
      );

      const setIdlePromise = manager.setIdle();
      expect(manager.isTerminalIdleInFlight()).toBe(true);
      const waiter = manager.waitForIdleTransition(undefined, () => events.push('onEnd'));
      void waiter.promise.then(() => events.push('waiter-resolved'));

      resolvePublish();
      await setIdlePromise;
      await waiter.promise;
      expect(events).toEqual(['onEnd', 'waiter-resolved']);
      expect(manager.isTerminalIdleInFlight()).toBe(false);
    });

    test('terminal idle in-flight flag clears when idle publication throws', async () => {
      emitMock.mockImplementation(async () => {
        throw new Error('publish failed');
      });

      await expect(manager.setIdle()).rejects.toThrow('publish failed');
      expect(manager.isTerminalIdleInFlight()).toBe(false);
    });

    test('beginTerminalIdle fences and fires onEnd without resolving until setIdle', async () => {
      const events: string[] = [];
      const waiter = manager.waitForIdleTransition(undefined, () => events.push('onEnd'));
      void waiter.promise.then(() => events.push('waiter-resolved'));

      manager.beginTerminalIdle();
      await Promise.resolve();
      expect(events).toEqual(['onEnd']);
      expect(manager.isTerminalIdleInFlight()).toBe(true);

      await manager.setIdle();
      await waiter.promise;
      expect(events).toEqual(['onEnd', 'waiter-resolved']);
      expect(manager.isTerminalIdleInFlight()).toBe(false);
    });

    test('waiter onEnd fires on a direct releaseIdleWaiters (restart/reset failure path)', async () => {
      // Direct releaseIdleWaiters (query-lifecycle restart/reset failures,
      // ask-user-question answer-reinjection) must still record the turn-end
      // marker — the waiter-owned callback covers it. See Codex (PR #2463, P2).
      let ended = false;
      manager.waitForIdleTransition(undefined, () => {
        ended = true;
      });
      manager.releaseIdleWaiters();
      await Promise.resolve();
      expect(ended).toBe(true);
    });

    test('cancel() does NOT fire onEnd (cleanup, not a turn-end) — P2', async () => {
      // cancel() is the delivery bridge's finally / rejected-acknowledgment /
      // query-close abandon path. It must NOT persist the turn-completion marker
      // (a consumed-but-never-delivered prompt must not be marked ended, or the
      // retried job completes without delivering). Only genuine terminal paths
      // (setIdle drain, releaseIdleWaiters) fire onEnd.
      let ended = false;
      const handle = manager.waitForIdleTransition(undefined, () => {
        ended = true;
      });
      handle.cancel();
      expect(ended).toBe(false);
    });

    test('waiter onEnd does NOT fire on a suppressed (retry mid-point) idle', async () => {
      let ended = false;
      manager.waitForIdleTransition(undefined, () => {
        ended = true;
      });
      await manager.setIdle({ suppressDeliveryWaiters: true });
      expect(ended).toBe(false);
    });

    test('clears pending question state', async () => {
      await manager.setWaitingForInput({ toolUseId: 'tool-123', questions: [] });

      await manager.setIdle();

      expect(manager.getState()).toEqual({ status: 'idle' });
      const savedState = JSON.parse(
        updateSessionMock.mock.calls[updateSessionMock.mock.calls.length - 1][1].processingState
      );
      expect(savedState).toEqual({ status: 'idle' });
    });
  });

  describe('waitForIdleTransition', () => {
    test('resolves on the next plain setIdle (terminal turn-end)', async () => {
      let resolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);
      await manager.setIdle();
      expect(resolved).toBe(true);
    });

    test('does NOT resolve on a suppressed (retry mid-point) setIdle, then does on a terminal one', async () => {
      // The contract every retry-path setIdle site depends on: a retry
      // mid-point (QueryRunner startup/message-not-found/transient, rate-limit,
      // ACP, AskUserQuestion restart) suppresses the drain so the durable
      // delivery job isn't completed while the prompt is still being retried.
      let resolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        resolved = true;
      });
      await manager.setIdle({ suppressDeliveryWaiters: true });
      expect(resolved).toBe(false);
      await manager.setIdle();
      expect(resolved).toBe(true);
    });

    test('cancel() is idempotent and releases the waiter without firing onEnd; a later terminal idle does not re-fire it', async () => {
      // cancel() is cleanup/abandon — it releases the awaiting job WITHOUT
      // persisting the turn-end marker. Idempotent (double cancel is a no-op),
      // and a later genuine terminal idle must not re-fire a cancelled waiter.
      let endedCount = 0;
      const handle = manager.waitForIdleTransition(undefined, () => endedCount++);
      let resolved = false;
      void handle.promise.then(() => {
        resolved = true;
      });
      handle.cancel();
      handle.cancel();
      await Promise.resolve();
      expect(endedCount).toBe(0); // no marker on cancel
      expect(resolved).toBe(true); // but the await IS released
      await manager.setIdle();
      expect(endedCount).toBe(0); // cancelled waiter isn't re-fired
    });

    test('drains waiters even when idle-state publication throws', async () => {
      // Resilient drain (setIdle try/finally): the state is persisted before
      // publish, so a publish failure must still release a waiting turn.
      const failingBus = {
        publish: mock(async () => {
          throw new Error('publish failed');
        }),
        publishAsync: mock(async () => {}),
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<any>;
      const failingManager = new ProcessingStateManager(sessionId, failingBus, createMockDb());
      let resolved = false;
      void failingManager.waitForIdleTransition().promise.then(() => {
        resolved = true;
      });
      await expect(failingManager.setIdle()).rejects.toThrow('publish failed');
      expect(resolved).toBe(true);
    });

    test('releaseIdleWaiters(gen) resolves only the matching episode, not a newer turn', async () => {
      // The race this guards: a superseded rate-limit retry (episode gen 0)
      // releases its turn-end waiter so its abandoned job doesn't hang — but a
      // NEWER turn (gen 1, armed after a cancel/reset bumped the generation) must
      // NOT have its waiter resolved, or its durable job completes prematurely and
      // frees the active-turn slot for a competing turn. driveDeliveryTurn tags
      // each waiter with the rate-limit generation at arm time; the superseded
      // retry releases only its own gen.
      let oldResolved = false;
      let newResolved = false;
      void manager.waitForIdleTransition(0).promise.then(() => {
        oldResolved = true;
      });
      void manager.waitForIdleTransition(1).promise.then(() => {
        newResolved = true;
      });

      manager.releaseIdleWaiters(0); // superseded gen-0 retry releases its own
      // releaseIdleWaiters is synchronous; flush the resolution microtask before
      // asserting (the .then handlers run on the next microtask tick).
      await Promise.resolve();

      expect(oldResolved).toBe(true);
      expect(newResolved).toBe(false);

      // The newer turn's waiter still resolves on a real terminal idle.
      await manager.setIdle();
      expect(newResolved).toBe(true);
    });

    test('releaseIdleWaiters() with no generation resolves all waiters (unscoped fallback)', async () => {
      // Omitting the generation (a release site that has no episode context)
      // resolves every armed waiter — preserving the original drain-all behavior
      // for callers that don't track a generation.
      let aResolved = false;
      let bResolved = false;
      void manager.waitForIdleTransition(0).promise.then(() => {
        aResolved = true;
      });
      void manager.waitForIdleTransition(5).promise.then(() => {
        bResolved = true;
      });

      manager.releaseIdleWaiters();
      await Promise.resolve();

      expect(aResolved).toBe(true);
      expect(bResolved).toBe(true);
    });
  });

  describe('onIdleCallback ordering (deferred restart)', () => {
    test('fires the callback BEFORE draining delivery waiters (ownership held through the restart)', async () => {
      // A deferred restart (settings change) runs as the onIdleCallback. It must
      // run BEFORE the waiters drain, or driveDeliveryTurn completes + frees the
      // active-turn slot while the restart is still stopping/starting the query
      // — a message arriving then starts a new turn concurrent with the restart.
      let waiterResolvedAtCallback = true;
      let waiterResolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        waiterResolved = true;
      });
      manager.setOnIdleCallback(async () => {
        // At callback time the waiter must still be pending — drain is deferred.
        waiterResolvedAtCallback = waiterResolved;
      });

      await manager.setIdle();
      await Promise.resolve();

      expect(waiterResolvedAtCallback).toBe(false); // NOT drained during the callback
      expect(waiterResolved).toBe(true); // drained after the callback completed
    });

    test('a reentrant terminal idle consumes its fence without draining early', async () => {
      let terminalInFlightAfterReentrantIdle = false;
      manager.setOnIdleCallback(async () => {
        manager.beginTerminalIdle();
        await manager.setIdle();
        terminalInFlightAfterReentrantIdle = manager.isTerminalIdleInFlight();
      });

      await manager.setIdle();

      expect(terminalInFlightAfterReentrantIdle).toBe(true); // outer transition still owns the drain
      expect(manager.isTerminalIdleInFlight()).toBe(false); // both transitions settled
    });

    test('a reentrant setIdle during the callback does not re-fire it or drain early', async () => {
      // The callback's restart drives its own idle (reentrant setIdle). The guard
      // must prevent a double restart AND keep the drain deferred to the outer
      // call (a reentrant drain would defeat the ordering above).
      let fires = 0;
      let outerResolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        outerResolved = true;
      });
      manager.setOnIdleCallback(async () => {
        fires += 1;
        await manager.setIdle(); // reentrant idle from the restart's stop/start
      });

      await manager.setIdle();
      await Promise.resolve();

      expect(fires).toBe(1); // reentrant idle did NOT re-fire the callback
      expect(outerResolved).toBe(true); // outer call drained after the callback
    });
  });

  describe('setQueued', () => {
    test('transitions to queued state', async () => {
      await manager.setQueued('msg-123');

      const state = manager.getState();
      expect(state.status).toBe('queued');
      expect(state.messageId).toBe('msg-123');
    });

    test('persists queued state to database', async () => {
      await manager.setQueued('msg-456');

      expect(updateSessionMock).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({
          processingState: JSON.stringify({ status: 'queued', messageId: 'msg-456' }),
        })
      );
    });

    test('emits session.updated event with queued state', async () => {
      await manager.setQueued('msg-789');

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: { status: 'queued', messageId: 'msg-789' },
        })
      );
    });
  });

  describe('setQueuedIfIdle', () => {
    test('sets the queued marker while idle and returns true', async () => {
      const didSet = await manager.setQueuedIfIdle('msg-turn');

      expect(didSet).toBe(true);
      expect(manager.getState()).toMatchObject({ status: 'queued', messageId: 'msg-turn' });
    });

    test('first writer wins — a concurrent send never steals the marker (#3743968035)', async () => {
      await manager.setQueuedIfIdle('msg-first');

      const didSet = await manager.setQueuedIfIdle('msg-second');

      expect(didSet).toBe(false);
      expect(manager.getState()).toMatchObject({ status: 'queued', messageId: 'msg-first' });
    });

    test('does not downgrade a processing session', async () => {
      await manager.setProcessing('msg-active');

      const didSet = await manager.setQueuedIfIdle('msg-steer');

      expect(didSet).toBe(false);
      expect(manager.getState().status).toBe('processing');
    });
  });

  describe('setProcessing', () => {
    test('transitions to processing state with default phase', async () => {
      await manager.setProcessing('msg-1');

      const state = manager.getState();
      expect(state.status).toBe('processing');
      expect(state.messageId).toBe('msg-1');
      expect(state.phase).toBe('initializing');
      expect(manager.isProcessing()).toBe(true);
    });

    test('transitions to processing state with custom phase', async () => {
      await manager.setProcessing('msg-2', 'thinking');

      const state = manager.getState();
      expect(state.phase).toBe('thinking');
    });

    test('transitions to processing state with streaming phase', async () => {
      await manager.setProcessing('msg-3', 'streaming');

      const state = manager.getState();
      expect(state.phase).toBe('streaming');
      expect(state.streamingStartedAt).toBeDefined();
    });

    test('includes isCompacting in processing state', async () => {
      await manager.setCompacting(true);
      await manager.setProcessing('msg-4');

      const state = manager.getState();
      expect(state.isCompacting).toBe(true);
    });

    test('persists processing state to database', async () => {
      await manager.setProcessing('msg-5', 'thinking');

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('processing');
      expect(savedState.phase).toBe('thinking');
    });
  });

  describe('setInterrupted', () => {
    test('transitions to interrupted state', async () => {
      await manager.setInterrupted();

      const state = manager.getState();
      expect(state.status).toBe('interrupted');
    });

    test('resets streaming phase tracking', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      await manager.setInterrupted();

      expect(manager.getIsCompacting()).toBe(false);
    });

    test('persists interrupted state to database', async () => {
      await manager.setInterrupted();

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('interrupted');
    });
  });

  describe('setWaitingForInput', () => {
    const pendingQuestion: PendingUserQuestion = {
      toolUseId: 'tool-123',
      questions: [
        {
          questionText: 'What would you like to do?',
          options: [{ optionText: 'Option A' }, { optionText: 'Option B' }],
        },
      ],
    };

    test('transitions to waiting_for_input state', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const state = manager.getState();
      expect(state.status).toBe('waiting_for_input');
      expect(manager.isWaitingForInput()).toBe(true);
    });

    test('stores pending question', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const stored = manager.getPendingQuestion();
      expect(stored).toEqual(pendingQuestion);
    });

    test('persists waiting_for_input state to database', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      expect(updateSessionMock).toHaveBeenCalled();

      const savedState = JSON.parse(updateSessionMock.mock.calls[0][1].processingState);
      expect(savedState.status).toBe('waiting_for_input');
      expect(savedState.pendingQuestion.toolUseId).toBe('tool-123');
    });

    test('returns null for getPendingQuestion when not waiting', () => {
      expect(manager.getPendingQuestion()).toBeNull();
    });
  });

  describe('updateQuestionDraft', () => {
    const pendingQuestion: PendingUserQuestion = {
      toolUseId: 'tool-456',
      questions: [
        {
          questionText: 'Select items:',
          options: [{ optionText: 'Item 1' }, { optionText: 'Item 2' }],
        },
      ],
    };

    test('updates draft responses when in waiting_for_input state', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [0] }];
      await manager.updateQuestionDraft(draftResponses);

      const question = manager.getPendingQuestion();
      expect(question?.draftResponses).toEqual(draftResponses);
    });

    test('persists draft updates to database', async () => {
      await manager.setWaitingForInput(pendingQuestion);

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [1] }];
      await manager.updateQuestionDraft(draftResponses);

      // Should have been called for both setWaitingForInput and updateQuestionDraft
      expect(updateSessionMock).toHaveBeenCalledTimes(2);
    });

    test('emits session.updated event with updated state', async () => {
      await manager.setWaitingForInput(pendingQuestion);
      emitMock.mockClear();

      const draftResponses = [{ questionIndex: 0, selectedOptionIndices: [0, 1] }];
      await manager.updateQuestionDraft(draftResponses);

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          source: 'processing-state',
          processingState: expect.objectContaining({
            status: 'waiting_for_input',
            pendingQuestion: expect.objectContaining({
              draftResponses,
            }),
          }),
        })
      );
    });

    test('does nothing when not in waiting_for_input state', async () => {
      emitMock.mockClear();
      updateSessionMock.mockClear();

      await manager.updateQuestionDraft([{ questionIndex: 0, selectedOptionIndices: [] }]);

      expect(emitMock).not.toHaveBeenCalled();
      expect(updateSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('setCompacting', () => {
    test('sets compacting to true', async () => {
      await manager.setProcessing('msg-1');
      await manager.setCompacting(true);

      expect(manager.getIsCompacting()).toBe(true);
    });

    test('sets compacting to false', async () => {
      await manager.setProcessing('msg-1');
      await manager.setCompacting(true);
      await manager.setCompacting(false);

      expect(manager.getIsCompacting()).toBe(false);
    });

    test('updates processing state when compacting changes during processing', async () => {
      await manager.setProcessing('msg-1');
      emitMock.mockClear();

      await manager.setCompacting(true);

      expect(emitMock).toHaveBeenCalledWith(
        'session.updated',
        expect.objectContaining({
          sessionId,
          processingState: expect.objectContaining({
            isCompacting: true,
          }),
        })
      );
    });

    test('does not emit event when not processing', async () => {
      await manager.setCompacting(true);

      // Only the initial setCompacting should set the internal flag
      expect(manager.getIsCompacting()).toBe(true);
    });
  });

  describe('updatePhase', () => {
    test('updates phase during processing', async () => {
      await manager.setProcessing('msg-1', 'initializing');
      await manager.updatePhase('thinking');

      const state = manager.getState();
      expect(state.phase).toBe('thinking');
    });

    test('transitions to streaming phase', async () => {
      await manager.setProcessing('msg-1', 'thinking');
      await manager.updatePhase('streaming');

      const state = manager.getState();
      expect(state.phase).toBe('streaming');
      expect(state.streamingStartedAt).toBeDefined();
    });

    test('transitions to finalizing phase', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      await manager.updatePhase('finalizing');

      const state = manager.getState();
      expect(state.phase).toBe('finalizing');
    });

    test('does nothing when not processing', async () => {
      emitMock.mockClear();

      await manager.updatePhase('thinking');

      expect(emitMock).not.toHaveBeenCalled();
    });

    test('persists phase update to database', async () => {
      await manager.setProcessing('msg-1', 'initializing');
      updateSessionMock.mockClear();

      await manager.updatePhase('thinking');

      expect(updateSessionMock).toHaveBeenCalled();
    });
  });

  describe('detectPhaseFromMessage', () => {
    test('does nothing when not processing', async () => {
      const message = { type: 'stream_event' } as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      // Should not throw and state should remain idle
      expect(manager.getState().status).toBe('idle');
    });

    test('transitions to streaming phase on stream_event', async () => {
      await manager.setProcessing('msg-1', 'thinking');

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('streaming');
    });

    test('transitions to thinking phase on assistant message with tool use', async () => {
      await manager.setProcessing('msg-1', 'initializing');

      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'test_tool', input: {} }],
        },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('thinking');
    });

    test('transitions to thinking phase on assistant message with text only', async () => {
      await manager.setProcessing('msg-1', 'initializing');

      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello!' }],
        },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('thinking');
    });

    test('transitions to finalizing phase on result message', async () => {
      await manager.setProcessing('msg-1', 'streaming');

      const message = {
        type: 'result',
        result: { status: 'success' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('finalizing');
    });

    test('does not transition when already in target phase', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      emitMock.mockClear();

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      // Should not emit since already in streaming phase
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe('restoreFromDatabase', () => {
    test('restores idle state from database', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({ status: 'idle' }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('restores waiting_for_input state from database', () => {
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: 'restored-tool',
        questions: [],
      };
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'waiting_for_input',
          pendingQuestion,
        }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('waiting_for_input');
      expect(manager.getPendingQuestion()?.toolUseId).toBe('restored-tool');
    });

    test('resets processing state to idle after restart', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'processing',
          messageId: 'old-msg',
          phase: 'thinking',
        }),
      }));

      manager.restoreFromDatabase();

      // Processing state should be reset to idle
      expect(manager.getState().status).toBe('idle');
    });

    test('resets queued state to idle after restart', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({
          status: 'queued',
          messageId: 'queued-msg',
        }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('handles missing processingState gracefully', () => {
      mockDb.getSession = mock(() => null);

      // Should not throw
      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('handles invalid JSON gracefully', () => {
      mockDb.getSession = mock(() => ({
        processingState: 'invalid json',
      }));

      // Should not throw
      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('restores interrupted state', () => {
      mockDb.getSession = mock(() => ({
        processingState: JSON.stringify({ status: 'interrupted' }),
      }));

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('interrupted');
    });
  });

  describe('state transition flow', () => {
    test('complete flow: idle -> queued -> processing -> idle', async () => {
      // Start idle
      expect(manager.getState().status).toBe('idle');

      // Queue message
      await manager.setQueued('msg-1');
      expect(manager.getState().status).toBe('queued');

      // Start processing
      await manager.setProcessing('msg-1', 'initializing');
      expect(manager.getState().status).toBe('processing');

      // Update phases
      await manager.updatePhase('thinking');
      expect(manager.getState().phase).toBe('thinking');

      await manager.updatePhase('streaming');
      expect(manager.getState().phase).toBe('streaming');

      await manager.updatePhase('finalizing');
      expect(manager.getState().phase).toBe('finalizing');

      // Back to idle
      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });

    test('flow with interrupt: idle -> processing -> interrupted -> idle', async () => {
      await manager.setProcessing('msg-1', 'streaming');
      expect(manager.getState().status).toBe('processing');

      await manager.setInterrupted();
      expect(manager.getState().status).toBe('interrupted');

      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });

    test('flow with waiting_for_input: idle -> processing -> waiting -> idle', async () => {
      await manager.setProcessing('msg-1', 'thinking');
      expect(manager.getState().status).toBe('processing');

      const question: PendingUserQuestion = {
        toolUseId: 'tool-1',
        questions: [],
      };
      await manager.setWaitingForInput(question);
      expect(manager.getState().status).toBe('waiting_for_input');
      expect(manager.isWaitingForInput()).toBe(true);

      await manager.setIdle();
      expect(manager.getState().status).toBe('idle');
    });
  });

  describe('database error handling', () => {
    test('handles database update failure gracefully', async () => {
      updateSessionMock = mock(() => {
        throw new Error('DB error');
      });
      mockDb = createMockDb();
      mockInternalEventBus = createMockInternalEventBus();
      manager = new ProcessingStateManager(sessionId, mockInternalEventBus, mockDb);

      // Should not throw
      await manager.setIdle();

      expect(manager.getState().status).toBe('idle');
    });
  });
});
