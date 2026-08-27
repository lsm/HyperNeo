import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentProcessingState, PendingUserQuestion } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

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

    test('suppressIdlePublish idles and persists without the session.updated event', async () => {
      const onIdleCallback = mock(async () => {});
      manager.setOnIdleCallback(onIdleCallback);
      await manager.setQueued('msg-1');
      emitMock.mockClear();

      await manager.setIdle({ suppressIdlePublish: true, suppressIdleCallback: true });

      expect(manager.getState().status).toBe('idle');
      expect(updateSessionMock).toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
      expect(onIdleCallback).not.toHaveBeenCalled();
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
      await manager.setProcessing('msg-1', 'streaming');

      await manager.setIdle();

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

      await manager.setIdle();

      expect(callbackMock).toHaveBeenCalled();
    });

    test('waiter onEnd fires BEFORE the waiter promise resolves on a terminal idle', async () => {
      const events: string[] = [];
      const waiter = manager.waitForIdleTransition(undefined, () => events.push('onEnd'));
      void waiter.promise.then(() => events.push('waiter-resolved'));
      await manager.setIdle();
      await waiter.promise;
      expect(events).toEqual(['onEnd', 'waiter-resolved']);
    });

    test('waiter onEnd (marker) fires BEFORE the awaited idle side effects (P2)', async () => {
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
      expect(events).toEqual(['onEnd']);
      expect(events).not.toContain('waiter-resolved');
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
      let ended = false;
      manager.waitForIdleTransition(undefined, () => {
        ended = true;
      });
      manager.releaseIdleWaiters();
      await Promise.resolve();
      expect(ended).toBe(true);
    });

    test('cancel() does NOT fire onEnd (cleanup, not a turn-end) — P2', async () => {
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
      let endedCount = 0;
      const handle = manager.waitForIdleTransition(undefined, () => endedCount++);
      let resolved = false;
      void handle.promise.then(() => {
        resolved = true;
      });
      handle.cancel();
      handle.cancel();
      await Promise.resolve();
      expect(endedCount).toBe(0);
      expect(resolved).toBe(true);
      await manager.setIdle();
      expect(endedCount).toBe(0);
    });

    test('drains waiters even when idle-state publication throws', async () => {
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
      let oldResolved = false;
      let newResolved = false;
      void manager.waitForIdleTransition(0).promise.then(() => {
        oldResolved = true;
      });
      void manager.waitForIdleTransition(1).promise.then(() => {
        newResolved = true;
      });

      manager.releaseIdleWaiters(0);
      await Promise.resolve();

      expect(oldResolved).toBe(true);
      expect(newResolved).toBe(false);

      await manager.setIdle();
      expect(newResolved).toBe(true);
    });

    test('releaseIdleWaiters() with no generation resolves all waiters (unscoped fallback)', async () => {
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

  describe('owner-carrier idle waiters', () => {
    function armTracked(owner?: { queryGeneration: number; turnToken: number }, gen?: number) {
      const flags = { ended: false, resolved: false };
      void manager
        .waitForIdleTransition(
          gen,
          () => {
            flags.ended = true;
          },
          owner
        )
        .promise.then(() => {
          flags.resolved = true;
        });
      return flags;
    }

    test('setIdle with a matching owner filter resolves the owned waiter', async () => {
      const owner = { queryGeneration: 0, turnToken: 0 };
      const waiter = armTracked(owner);

      await manager.setIdle({ owner });

      expect(waiter).toEqual({ ended: true, resolved: true });
    });

    test('setIdle with a foreign owner holds the waiter until its own idle', async () => {
      const first = { queryGeneration: 0, turnToken: 0 };
      const successor = { queryGeneration: 0, turnToken: 1 };
      const waiter = armTracked(first);

      await manager.setIdle({ owner: successor });
      expect(waiter).toEqual({ ended: false, resolved: false });

      await manager.setIdle({ owner: first });
      expect(waiter).toEqual({ ended: true, resolved: true });
    });

    test('an owner-filtered idle still drains unowned waiters (legacy behavior)', async () => {
      const legacy = armTracked();

      await manager.setIdle({ owner: { queryGeneration: 5, turnToken: 5 } });

      expect(legacy).toEqual({ ended: true, resolved: true });
    });

    test('beginTerminalIdle fires onEnd only for the matching owner', async () => {
      const matching = armTracked({ queryGeneration: 0, turnToken: 0 });
      const foreign = armTracked({ queryGeneration: 1, turnToken: 0 });

      manager.beginTerminalIdle({ queryGeneration: 0, turnToken: 0 });
      await Promise.resolve();

      expect(matching.ended).toBe(true);
      expect(matching.resolved).toBe(false);
      expect(foreign.ended).toBe(false);

      await manager.setIdle();

      expect(matching.resolved).toBe(true);
      expect(foreign.resolved).toBe(false);
    });

    test('releaseIdleWaiters ANDs the episode filter with the owner filter', async () => {
      const matched = armTracked({ queryGeneration: 0, turnToken: 0 }, 0);
      const wrongOwner = armTracked({ queryGeneration: 1, turnToken: 0 }, 0);
      const wrongGen = armTracked({ queryGeneration: 0, turnToken: 0 }, 1);

      manager.releaseIdleWaiters(0, { queryGeneration: 0, turnToken: 0 });
      await Promise.resolve();

      expect(matched.resolved).toBe(true);
      expect(wrongOwner.resolved).toBe(false);
      expect(wrongGen.resolved).toBe(false);
    });

    test('a suppressed setIdle leaves owned waiters armed', async () => {
      const waiter = armTracked({ queryGeneration: 0, turnToken: 0 });

      await manager.setIdle({ suppressDeliveryWaiters: true });
      expect(waiter).toEqual({ ended: false, resolved: false });

      await manager.setIdle();
      expect(waiter).toEqual({ ended: true, resolved: true });
    });
  });

  describe('query-owner idle filter (B5e)', () => {
    function armOwnedWaiter(owner: { queryGeneration: number; turnToken: number }) {
      const flags = { ended: false, resolved: false };
      void manager
        .waitForIdleTransition(
          undefined,
          () => {
            flags.ended = true;
          },
          owner
        )
        .promise.then(() => {
          flags.resolved = true;
        });
      return flags;
    }

    test('noteQueryOwnerGeneration advances the epoch: a stale owned waiter no longer consumes the successor idle', async () => {
      const staleWaiter = armOwnedWaiter({ queryGeneration: 1, turnToken: 0 });
      manager.noteQueryOwnerGeneration(2);

      await manager.setIdle({ owner: manager.idleOwnerForQuery(2) });

      expect(staleWaiter).toEqual({ ended: false, resolved: false });
      expect(manager.getState().status).toBe('idle');
    });

    test('a stale owned waiter is spared even by a plain unscoped successor idle', async () => {
      const staleWaiter = armOwnedWaiter({ queryGeneration: 1, turnToken: 0 });
      manager.noteQueryOwnerGeneration(2);

      await manager.setIdle();

      expect(staleWaiter.resolved).toBe(false);
    });

    test('replacement during the idle publication skips the onIdle callback and the successor waiter (B5e pin)', async () => {
      const onIdleCallback = mock(async () => {});
      manager.setOnIdleCallback(onIdleCallback);
      manager.noteQueryOwnerGeneration(3);
      let releasePublish!: () => void;
      emitMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releasePublish = resolve;
          })
      );

      const settling = manager.setIdle({ owner: manager.idleOwnerForQuery(3) });
      manager.noteQueryOwnerGeneration(4);
      const successorWaiter = armOwnedWaiter(manager.idleOwnerForQuery(4));

      releasePublish();
      emitMock.mockImplementation(async () => {});
      await settling;

      expect(onIdleCallback).not.toHaveBeenCalled();
      expect(successorWaiter.resolved).toBe(false);

      await manager.setIdle({ owner: manager.idleOwnerForQuery(4) });

      expect(successorWaiter.resolved).toBe(true);
      expect(onIdleCallback).toHaveBeenCalledTimes(1);
    });

    test('a stale owner settle preserves the successor processing state and balances the terminal counters', async () => {
      const onIdleCallback = mock(async () => {});
      manager.setOnIdleCallback(onIdleCallback);
      manager.noteQueryOwnerGeneration(1);
      const staleOwner = manager.idleOwnerForQuery(1);
      manager.beginTerminalIdle(staleOwner);
      manager.noteQueryOwnerGeneration(2);
      await manager.setProcessing('successor-msg');

      await manager.setIdle({ owner: staleOwner });

      expect(manager.getState().status).toBe('processing');
      expect(onIdleCallback).not.toHaveBeenCalled();
      expect(manager.isTerminalIdlePending()).toBe(false);
      expect(manager.isTerminalIdleInFlight()).toBe(false);

      await manager.setIdle({ owner: manager.idleOwnerForQuery(2) });

      expect(manager.getState().status).toBe('idle');
      expect(onIdleCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('onIdleCallback ordering (deferred restart)', () => {
    test('fires the callback BEFORE draining delivery waiters (ownership held through the restart)', async () => {
      let waiterResolvedAtCallback = true;
      let waiterResolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        waiterResolved = true;
      });
      manager.setOnIdleCallback(async () => {
        waiterResolvedAtCallback = waiterResolved;
      });

      await manager.setIdle();
      await Promise.resolve();

      expect(waiterResolvedAtCallback).toBe(false);
      expect(waiterResolved).toBe(true);
    });

    test('a reentrant terminal idle consumes its fence without draining early', async () => {
      let terminalInFlightAfterReentrantIdle = false;
      manager.setOnIdleCallback(async () => {
        manager.beginTerminalIdle();
        await manager.setIdle();
        terminalInFlightAfterReentrantIdle = manager.isTerminalIdleInFlight();
      });

      await manager.setIdle();

      expect(terminalInFlightAfterReentrantIdle).toBe(true);
      expect(manager.isTerminalIdleInFlight()).toBe(false);
    });

    test('a reentrant setIdle during the callback does not re-fire it or drain early', async () => {
      let fires = 0;
      let outerResolved = false;
      void manager.waitForIdleTransition().promise.then(() => {
        outerResolved = true;
      });
      manager.setOnIdleCallback(async () => {
        fires += 1;
        await manager.setIdle();
      });

      await manager.setIdle();
      await Promise.resolve();

      expect(fires).toBe(1);
      expect(outerResolved).toBe(true);
    });
  });

  describe('idle/waiter-release baseline (pre-owner-scoping, B5e)', () => {
    test('a plain setIdle wakes waiters of every episode generation (unscoped drain)', async () => {
      const ended: number[] = [];
      let oldResolved = false;
      let newResolved = false;
      void manager
        .waitForIdleTransition(0, () => ended.push(0))
        .promise.then(() => {
          oldResolved = true;
        });
      void manager
        .waitForIdleTransition(5, () => ended.push(5))
        .promise.then(() => {
          newResolved = true;
        });

      await manager.setIdle();

      expect(oldResolved).toBe(true);
      expect(newResolved).toBe(true);
      expect(ended).toEqual([0, 5]);
    });

    test('beginTerminalIdle fires onEnd for waiters of every episode generation', async () => {
      const ended: number[] = [];
      let resolved = false;
      void manager
        .waitForIdleTransition(0, () => ended.push(0))
        .promise.then(() => {
          resolved = true;
        });
      manager.waitForIdleTransition(5, () => ended.push(5));

      manager.beginTerminalIdle();
      await Promise.resolve();

      expect(ended).toEqual([0, 5]);
      expect(resolved).toBe(false);
      expect(manager.isTerminalIdleInFlight()).toBe(true);
    });

    test('a waiter armed while the onIdle callback runs is swept by the enclosing setIdle', async () => {
      const events: string[] = [];
      let releaseCallback!: () => void;
      let lateResolved = false;
      manager.setOnIdleCallback(
        () =>
          new Promise<void>((resolve) => {
            releaseCallback = resolve;
          })
      );

      const settle = manager.setIdle();
      await new Promise((r) => setTimeout(r, 0));
      expect(typeof releaseCallback).toBe('function');
      const late = manager.waitForIdleTransition(3, () => events.push('late-onEnd'));
      void late.promise.then(() => {
        lateResolved = true;
      });

      releaseCallback();
      await settle;

      expect(events).toEqual(['late-onEnd']);
      expect(lateResolved).toBe(true);
    });

    test('suppressIdleCallback alone still drains the waiters and publishes the idle state', async () => {
      const onIdleCallback = mock(async () => {});
      manager.setOnIdleCallback(onIdleCallback);
      let resolved = false;
      let ended = false;
      void manager
        .waitForIdleTransition(undefined, () => {
          ended = true;
        })
        .promise.then(() => {
          resolved = true;
        });

      await manager.setIdle({ suppressIdleCallback: true });

      expect(resolved).toBe(true);
      expect(ended).toBe(true);
      expect(onIdleCallback).not.toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalled();
    });

    test('a racing setIdle from outside while the callback is in flight stays fully quiet', async () => {
      const events: string[] = [];
      let releaseCallback!: () => void;
      let resolved = false;
      manager.setOnIdleCallback(
        () =>
          new Promise<void>((resolve) => {
            releaseCallback = resolve;
          })
      );
      void manager
        .waitForIdleTransition(undefined, () => events.push('onEnd'))
        .promise.then(() => {
          resolved = true;
        });

      const settle = manager.setIdle();
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual(['onEnd']);
      expect(resolved).toBe(false);

      await manager.setIdle();

      expect(manager.getState().status).toBe('idle');
      expect(resolved).toBe(false);
      expect(events).toEqual(['onEnd']);

      releaseCallback();
      await settle;

      expect(resolved).toBe(true);
      expect(events).toEqual(['onEnd']);
    });

    test('the onIdle callback waits for the idle publication to complete', async () => {
      let statusInCallback: string | undefined;
      let callbackRan = false;
      let releasePublish!: () => void;
      manager.setOnIdleCallback(async () => {
        callbackRan = true;
        statusInCallback = manager.getState().status;
      });
      await manager.setProcessing('msg-1');
      emitMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releasePublish = resolve;
          })
      );

      const settle = manager.setIdle();
      await new Promise((r) => setTimeout(r, 0));
      expect(typeof releasePublish).toBe('function');
      expect(callbackRan).toBe(false);

      releasePublish();
      await settle;

      expect(callbackRan).toBe(true);
      expect(statusInCallback).toBe('idle');
    });

    test('releaseIdleWaiters(gen) fires onEnd only for the matching waiter', async () => {
      const events: number[] = [];
      let successorEnded = false;
      void manager.waitForIdleTransition(2, () => events.push(2));
      manager.waitForIdleTransition(3, () => {
        successorEnded = true;
      });

      manager.releaseIdleWaiters(2);
      await Promise.resolve();

      expect(events).toEqual([2]);
      expect(successorEnded).toBe(false);

      await manager.setIdle();
      expect(successorEnded).toBe(true);
      expect(events).toEqual([2]);
    });

    test('releaseIdleWaiters is not a terminal idle: no state change, no fence, no re-fire', async () => {
      const events: string[] = [];
      await manager.setProcessing('msg-1');
      emitMock.mockClear();
      let resolved = false;
      void manager
        .waitForIdleTransition(undefined, () => events.push('onEnd'))
        .promise.then(() => {
          resolved = true;
        });

      manager.releaseIdleWaiters();
      await Promise.resolve();

      expect(resolved).toBe(true);
      expect(manager.getState().status).toBe('processing');
      expect(manager.isTerminalIdleInFlight()).toBe(false);
      expect(manager.isTerminalIdlePending()).toBe(false);
      expect(emitMock).not.toHaveBeenCalled();

      await manager.setIdle();
      expect(events).toEqual(['onEnd']);
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

      expect(manager.getIsCompacting()).toBe(true);
    });
  });

  describe('updatePhase', () => {
    describe('detectPhaseFromMessage: stream_event delta classification', () => {
      const streamEvent = (event: Record<string, unknown>): SDKMessage =>
        ({
          type: 'stream_event',
          event,
          parent_tool_use_id: null,
          uuid: 'stream-uuid',
          session_id: sessionId,
        }) as unknown as SDKMessage;

      test('text deltas set the streaming phase', async () => {
        await manager.setProcessing('msg-1', 'thinking');
        await manager.detectPhaseFromMessage(
          streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
        );
        expect(manager.getState().phase).toBe('streaming');
      });

      test('thinking deltas keep the Thinking phase (extended thinking is not Streaming)', async () => {
        await manager.setProcessing('msg-1', 'initializing');
        for (let i = 0; i < 3; i++) {
          await manager.detectPhaseFromMessage(
            streamEvent({
              type: 'content_block_delta',
              delta: { type: 'thinking_delta', thinking: '…' },
            })
          );
        }
        expect(manager.getState().phase).toBe('thinking');
        await manager.updatePhase('streaming');
        await manager.detectPhaseFromMessage(
          streamEvent({ type: 'content_block_start', content_block: { type: 'thinking' } })
        );
        expect(manager.getState().phase).toBe('thinking');
      });

      test('phase-neutral stream frames (message_start, ping, …) leave the phase untouched', async () => {
        await manager.setProcessing('msg-1', 'thinking');
        for (const neutral of [
          { type: 'message_start' },
          { type: 'content_block_start', content_block: { type: 'text' } },
          { type: 'content_block_stop' },
          { type: 'message_delta' },
          { type: 'ping' },
        ]) {
          await manager.detectPhaseFromMessage(streamEvent(neutral));
        }
        expect(manager.getState().phase).toBe('thinking');
      });

      test('no phase update when not processing', async () => {
        emitMock.mockClear();
        await manager.detectPhaseFromMessage(
          streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })
        );
        expect(emitMock).not.toHaveBeenCalled();
      });
    });

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

      expect(manager.getState().status).toBe('idle');
    });

    test('transitions to streaming phase on a text-delta stream_event', async () => {
      await manager.setProcessing('msg-1', 'thinking');

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('streaming');
    });

    test('a stream_event without a recognizable delta leaves the phase untouched', async () => {
      await manager.setProcessing('msg-1', 'thinking');

      const message = {
        type: 'stream_event',
        event: { type: 'content_block_delta' },
      } as unknown as SDKMessage;
      await manager.detectPhaseFromMessage(message);

      expect(manager.getState().phase).toBe('thinking');
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

      manager.restoreFromDatabase();

      expect(manager.getState().status).toBe('idle');
    });

    test('handles invalid JSON gracefully', () => {
      mockDb.getSession = mock(() => ({
        processingState: 'invalid json',
      }));

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
      expect(manager.getState().status).toBe('idle');

      await manager.setQueued('msg-1');
      expect(manager.getState().status).toBe('queued');

      await manager.setProcessing('msg-1', 'initializing');
      expect(manager.getState().status).toBe('processing');

      await manager.updatePhase('thinking');
      expect(manager.getState().phase).toBe('thinking');

      await manager.updatePhase('streaming');
      expect(manager.getState().phase).toBe('streaming');

      await manager.updatePhase('finalizing');
      expect(manager.getState().phase).toBe('finalizing');

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

      await manager.setIdle();

      expect(manager.getState().status).toBe('idle');
    });
  });
});
