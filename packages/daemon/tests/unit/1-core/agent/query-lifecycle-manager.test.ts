/**
 * Tests for QueryLifecycleManager
 *
 * Coverage for:
 * - stop: Stopping query with various options
 * - restart: Stop + start sequence
 * - reset: Full reset with cost tracking, state management, and notifications
 * - ensureQueryStarted: Starting query with interrupt handling
 * - startQueryAndEnqueue: Starting query and enqueueing messages
 */

import { describe, test, expect, beforeEach, mock, spyOn, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QueryLifecycleManager,
  type QueryLifecycleManagerContext,
} from '../../../../src/lib/agent/query-lifecycle-manager';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Session, MessageHub } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { InterruptHandler } from '../../../../src/lib/agent/interrupt-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';

describe('QueryLifecycleManager', () => {
  let manager: QueryLifecycleManager;
  let messageQueue: MessageQueue;
  let mockContext: QueryLifecycleManagerContext;
  let startStreamingCalled: boolean;

  // Mock spies
  let updateSessionSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let saveHyperNeoActionMessageSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let setQueuedSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let releaseIdleWaitersSpy: ReturnType<typeof mock>;
  let resetCircuitBreakerSpy: ReturnType<typeof mock>;
  let getInterruptPromiseSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let clearModelsCacheSpy: ReturnType<typeof mock>;
  let terminateTrackedAgentProcessesSpy: ReturnType<typeof mock>;
  let snapshotTrackedAgentProcessesSpy: ReturnType<typeof mock>;
  let internalPublishAsyncSpy: ReturnType<typeof mock>;
  let internalPublishSpy: ReturnType<typeof mock>;
  let hasUnresolvedResumeChoice: boolean;

  function createMockContext(
    overrides: Partial<QueryLifecycleManagerContext> = {}
  ): QueryLifecycleManagerContext {
    const mockSession: Session = {
      id: 'test-session',
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {},
    };

    updateSessionSpy = mock(() => {});
    updateMessageStatusSpy = mock(() => {});
    getMessagesByStatusSpy = mock((_sessionId: string, status: string) => {
      if (status !== 'enqueued') {
        return [];
      }
      return [
        {
          dbId: 'db-msg-123',
          type: 'user',
          uuid: 'msg-123',
          session_id: 'test-session',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
          timestamp: Date.now(),
        },
      ];
    });
    hasUnresolvedResumeChoice = false;
    saveHyperNeoActionMessageSpy = mock(() => {
      hasUnresolvedResumeChoice = true;
      return 'row-id-mock';
    });
    publishSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    setQueuedSpy = mock(async () => {});
    getStateSpy = mock(() => ({ status: 'idle' }));
    releaseIdleWaitersSpy = mock(() => {});
    resetCircuitBreakerSpy = mock(() => {});
    getInterruptPromiseSpy = mock(() => null);
    handleErrorSpy = mock(async () => {});
    clearModelsCacheSpy = mock(async () => {});
    terminateTrackedAgentProcessesSpy = mock(() => {});
    snapshotTrackedAgentProcessesSpy = mock(() => []);
    internalPublishAsyncSpy = mock(async () => {});
    internalPublishSpy = mock(async () => {});

    startStreamingCalled = false;
    return {
      session: mockSession,
      messageQueue,
      db: {
        updateSession: updateSessionSpy,
        updateMessageStatus: updateMessageStatusSpy,
        getMessagesByStatus: getMessagesByStatusSpy,
        saveHyperNeoActionMessage: saveHyperNeoActionMessageSpy,
        getSDKMessageRepo: () => ({
          hasUnresolvedHyperNeoAction: () => hasUnresolvedResumeChoice,
        }),
      } as unknown as Database,
      messageHub: {
        event: publishSpy,
        onRequest: mock((_method: string, _handler: Function) => () => {}),
        query: mock(async () => ({})),
        command: mock(async () => {}),
      } as unknown as MessageHub,
      internalEventBus: {
        publish: internalPublishSpy,
        publishAsync: internalPublishAsyncSpy,
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<any>,
      stateManager: {
        setIdle: setIdleSpy,
        setQueued: setQueuedSpy,
        getState: getStateSpy,
        releaseIdleWaiters: releaseIdleWaitersSpy,
      } as unknown as ProcessingStateManager,
      messageHandler: {
        resetCircuitBreaker: resetCircuitBreakerSpy,
      } as unknown as SDKMessageHandler,
      interruptHandler: {
        getInterruptPromise: getInterruptPromiseSpy,
      } as unknown as InterruptHandler,
      errorManager: {
        handleError: handleErrorSpy,
      } as unknown as ErrorManager,
      queryObject: null,
      queryPromise: null,
      firstMessageReceived: true,
      pendingRestartReason: null,
      startStreamingQuery: async () => {
        startStreamingCalled = true;
        messageQueue.start();
        mockContext.queryPromise = Promise.resolve();
      },
      processExitedPromise: null,
      resetProcessExitedPromise: mock(() => {
        mockContext.processExitedPromise = null;
      }),
      startupTimeoutTimer: null,
      queryAbortController: null,
      terminateTrackedAgentProcesses: terminateTrackedAgentProcessesSpy,
      snapshotTrackedAgentProcesses: snapshotTrackedAgentProcessesSpy,
      // Cleanup support methods
      setCleaningUp: mock(() => {}),
      cleanupEventSubscriptions: mock(() => {}),
      clearModelsCache: clearModelsCacheSpy,
      ...overrides,
    };
  }

  beforeEach(() => {
    messageQueue = new MessageQueue('test-session');
    mockContext = createMockContext();
    manager = new QueryLifecycleManager(mockContext);
  });

  describe('stop', () => {
    test('stops message queue', async () => {
      const stopSpy = spyOn(messageQueue, 'stop');

      await manager.stop();

      expect(stopSpy).toHaveBeenCalled();
    });

    test('interrupts query when transport is ready', async () => {
      let interruptCalled = false;
      mockContext.queryObject = {
        interrupt: mock(async () => {
          interruptCalled = true;
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(interruptCalled).toBe(true);
    });

    test('skips interrupt when transport is not ready', async () => {
      let interruptCalled = false;
      mockContext.queryObject = {
        interrupt: mock(async () => {
          interruptCalled = true;
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = false;
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(interruptCalled).toBe(false);
    });

    test('handles interrupt errors gracefully', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {
          throw new Error('Interrupt failed');
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.stop();
    });

    test('waits for query promise to resolve', async () => {
      let promiseResolved = false;
      mockContext.queryPromise = new Promise((resolve) => {
        setTimeout(() => {
          promiseResolved = true;
          resolve();
        }, 10);
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(promiseResolved).toBe(true);
    });

    test('times out waiting for query promise', async () => {
      mockContext.queryPromise = new Promise(() => {
        // Never resolves
      });
      manager = new QueryLifecycleManager(mockContext);

      const start = Date.now();
      await manager.stop({ timeoutMs: 100 });
      const elapsed = Date.now() - start;

      // Should have timed out around 100ms
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(200);
    });

    test('catches query errors when option is set', async () => {
      mockContext.queryPromise = Promise.reject(new Error('Query failed'));
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw with catchQueryErrors: true
      await manager.stop({ catchQueryErrors: true });
    });

    test('clears query references after stop', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(mockContext.queryObject).toBeNull();
      expect(mockContext.queryPromise).toBeNull();
    });

    test('handles null query object', async () => {
      mockContext.queryObject = null;
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.stop();
    });

    test('handles query object without interrupt method', async () => {
      mockContext.queryObject = {} as QueryLifecycleManagerContext['queryObject'];
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.stop();
    });

    test('terminates tracked process group before closing query object', async () => {
      const closeMock = mock(() => {});
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: closeMock,
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledWith({
        forceDelayMs: 2000,
        processes: [],
        noPidProcesses: [],
      });
      expect(closeMock).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy.mock.invocationCallOrder[0]).toBeLessThan(
        closeMock.mock.invocationCallOrder[0]
      );
    });

    test('calls close() on query object to terminate subprocess', async () => {
      let closeCalled = false;
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {
          closeCalled = true;
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(closeCalled).toBe(true);
    });

    test('calls close() even when transport is not ready (firstMessageReceived=false)', async () => {
      let closeCalled = false;
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {
          closeCalled = true;
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = false;
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(closeCalled).toBe(true);
    });

    test('handles close() errors gracefully', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {
          throw new Error('Close failed');
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.stop();
    });

    test('clears query references after close()', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      expect(mockContext.queryObject).toBeNull();
      expect(mockContext.queryPromise).toBeNull();
    });

    test('calls close() after query promise resolves', async () => {
      const callOrder: string[] = [];
      mockContext.queryObject = {
        interrupt: mock(async () => {
          callOrder.push('interrupt');
        }),
        close: mock(() => {
          callOrder.push('close');
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      mockContext.queryPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          callOrder.push('promise');
          resolve();
        }, 10);
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      const interruptIdx = callOrder.indexOf('interrupt');
      const promiseIdx = callOrder.indexOf('promise');
      const closeIdx = callOrder.indexOf('close');
      expect(interruptIdx).not.toBe(-1);
      expect(promiseIdx).not.toBe(-1);
      expect(closeIdx).not.toBe(-1);
      expect(interruptIdx).toBeLessThan(promiseIdx);
      expect(promiseIdx).toBeLessThan(closeIdx);
    });

    test('awaits processExitedPromise after close() before clearing references', async () => {
      const callOrder: string[] = [];
      let resolveExit: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {
          callOrder.push('close');
          // Simulate subprocess exit after a short delay (as it would in reality)
          setTimeout(() => {
            callOrder.push('process-exited');
            resolveExit!();
          }, 20);
        }),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      mockContext.queryPromise = Promise.resolve();
      mockContext.processExitedPromise = exitPromise;
      manager = new QueryLifecycleManager(mockContext);

      await manager.stop();

      // Process should have exited before stop() returned
      expect(callOrder).toContain('close');
      expect(callOrder).toContain('process-exited');
      expect(mockContext.processExitedPromise).toBeNull();
    });

    test('stop() times out waiting for processExitedPromise', async () => {
      const closeMock = mock(() => {});
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: closeMock,
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      mockContext.queryPromise = Promise.resolve();
      // A promise that never resolves — simulates a stuck subprocess
      mockContext.processExitedPromise = new Promise<void>(() => {});
      manager = new QueryLifecycleManager(mockContext);

      const start = Date.now();
      await manager.stop({ timeoutMs: 100 });
      const elapsed = Date.now() - start;

      // Should have timed out at the specified timeout
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(300);
      // close() must be called so the subprocess is not silently leaked
      expect(closeMock).toHaveBeenCalled();
      // All three context references are cleared even after a timeout
      expect(mockContext.queryObject).toBeNull();
      expect(mockContext.queryPromise).toBeNull();
      expect(mockContext.processExitedPromise).toBeNull();
    });

    test('stop() works when processExitedPromise is null', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      mockContext.queryPromise = Promise.resolve();
      mockContext.processExitedPromise = null;
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw or hang
      await manager.stop();

      expect(mockContext.queryObject).toBeNull();
    });

    test('stop() awaits already-resolved processExitedPromise without delay', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
        close: mock(() => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.firstMessageReceived = true;
      mockContext.queryPromise = Promise.resolve();
      // Process already exited
      mockContext.processExitedPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      const start = Date.now();
      await manager.stop();
      const elapsed = Date.now() - start;

      // Should complete near-instantly
      expect(elapsed).toBeLessThan(100);
      expect(mockContext.processExitedPromise).toBeNull();
    });

    test('snapshots processExitedPromise before queryPromise settles (regression for race condition)', async () => {
      // Simulate the race: runQuery's finally block clears ctx.processExitedPromise during settlement.
      // The old code read this.ctx.processExitedPromise AFTER awaiting queryPromise,
      // so by then the finally block had already nulled it — making the exit wait a no-op.
      // The fix snapshots it at the top of stop(), before any awaits.
      let resolveQueryPromise!: () => void;
      let resolveProcessExited!: () => void;
      const processExitedPromise = new Promise<void>((r) => (resolveProcessExited = r));

      // When queryPromise resolves, its finally block clears ctx.processExitedPromise
      // (mirrors what runQuery() does in production)
      const queryPromise = new Promise<void>((r) => (resolveQueryPromise = r)).then(() => {
        mockContext.processExitedPromise = null; // mirrors runQuery()'s finally block
      });

      mockContext.queryPromise = queryPromise;
      mockContext.processExitedPromise = processExitedPromise;
      manager = new QueryLifecycleManager(mockContext);

      // Start stop() but don't await yet
      const stopPromise = manager.stop();

      // Let queryPromise resolve (clears ctx.processExitedPromise as in production)
      resolveQueryPromise();
      await Promise.resolve(); // yield to let .then() run

      // stop() should still be waiting for process exit (via the snapshot)
      let stopResolved = false;
      stopPromise.then(() => (stopResolved = true));
      await Promise.resolve();
      expect(stopResolved).toBe(false); // not done yet — waiting for process exit

      // Now resolve process exit — stop() should complete
      resolveProcessExited();
      await stopPromise;
      expect(stopResolved).toBe(true);
    });
  });

  describe('restart', () => {
    test('stops and starts query', async () => {
      await manager.restart();

      expect(startStreamingCalled).toBe(true);
    });

    test('clears models cache before starting new query', async () => {
      await manager.restart();

      expect(clearModelsCacheSpy).toHaveBeenCalled();
    });

    test('throws on start failure', async () => {
      const failingContext = createMockContext({
        startStreamingQuery: async () => {
          throw new Error('Start failed');
        },
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      await expect(failingManager.restart()).rejects.toThrow('Query restart failed: Start failed');
    });

    test('releases delivery waiters when restart fails before a replacement query starts (Codex P1)', async () => {
      // The post-stop setIdle suppresses the waiter drain (the turn continues in
      // the restarted query). If startStreamingQuery throws, no replacement is
      // established — release the waiter so the durable turn doesn't hang
      // `processing` and block the active-turn slot.
      const failingContext = createMockContext({
        startStreamingQuery: async () => {
          throw new Error('Start failed');
        },
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      await expect(failingManager.restart()).rejects.toThrow('Query restart failed');
      expect(releaseIdleWaitersSpy).toHaveBeenCalledTimes(1);
    });

    test('does NOT release waiters when restart fails before the old query is stopped (Codex P1)', async () => {
      // A failure before stop() — here a session.errorClear subscriber rejecting
      // — leaves the original SDK query still running. Releasing the waiter would
      // complete the delivery job and free the active-turn slot mid-turn. Only
      // release once the suppressed idle is reached (stop succeeded).
      const failingContext = createMockContext({
        internalEventBus: {
          publish: mock(async () => {
            throw new Error('errorClear subscriber rejected');
          }),
          publishAsync: mock(async () => {}),
          subscribe: mock(() => () => {}),
        } as unknown as QueryLifecycleManagerContext['internalEventBus'],
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      await expect(failingManager.restart()).rejects.toThrow('Query restart failed');
      expect(releaseIdleWaitersSpy).not.toHaveBeenCalled();
    });

    test('throws on stop failure with meaningful message', async () => {
      const failingContext = createMockContext({
        queryObject: {
          interrupt: async () => {
            throw new Error('Stop failed');
          },
        } as unknown as QueryLifecycleManagerContext['queryObject'],
        queryPromise: new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Promise rejected')), 0);
        }),
        firstMessageReceived: true,
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      // Even with interrupt failure, should continue
      await failingManager.restart();
    });
  });

  describe('reset', () => {
    test('returns early when no query is running', async () => {
      // No queryObject or queryPromise set
      const result = await manager.reset();

      expect(result.success).toBe(true);
      expect(resetCircuitBreakerSpy).toHaveBeenCalled();
      expect(setIdleSpy).toHaveBeenCalled();
      // Should not start a new query in early return path
      expect(startStreamingCalled).toBe(false);
    });

    test('clears models cache on early return when no query is running', async () => {
      // No queryObject or queryPromise set
      await manager.reset();

      expect(clearModelsCacheSpy).toHaveBeenCalled();
    });

    test('clears pendingRestartReason on early return', async () => {
      mockContext.pendingRestartReason = 'settings.local.json';
      manager = new QueryLifecycleManager(mockContext);

      await manager.reset();

      expect(mockContext.pendingRestartReason).toBeNull();
    });

    test('clears ACP resume state on reset when no query is running', async () => {
      mockContext.session.config.provider = 'acp';
      mockContext.session.acpSessionId = 'stale-acp-session';
      mockContext.session.metadata = { acpInstructionsSent: true } as Session['metadata'];
      manager = new QueryLifecycleManager(mockContext);

      const result = await manager.reset();

      expect(result.success).toBe(true);
      expect(mockContext.session.acpSessionId).toBeUndefined();
      expect(mockContext.session.metadata.acpInstructionsSent).toBeUndefined();
      expect(updateSessionSpy).toHaveBeenCalledWith(
        'test-session',
        expect.objectContaining({
          acpSessionId: undefined,
          metadata: expect.objectContaining({ acpInstructionsSent: undefined }),
        })
      );
    });

    test('clears ACP resume state on reset before restart', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      mockContext.session.config.provider = 'acp';
      mockContext.session.acpSessionId = 'stale-acp-session';
      mockContext.session.metadata = { acpInstructionsSent: true } as Session['metadata'];
      manager = new QueryLifecycleManager(mockContext);

      const result = await manager.reset({ restartAfter: true });

      expect(result.success).toBe(true);
      expect(mockContext.session.acpSessionId).toBeUndefined();
      expect(mockContext.session.metadata.acpInstructionsSent).toBeUndefined();
      expect(updateSessionSpy).toHaveBeenCalledWith(
        'test-session',
        expect.objectContaining({
          acpSessionId: undefined,
          metadata: expect.objectContaining({ acpInstructionsSent: undefined }),
        })
      );
      expect(startStreamingCalled).toBe(true);
    });

    test('executes full reset sequence with running query', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      const result = await manager.reset({ restartAfter: true });

      expect(result.success).toBe(true);
      expect(resetCircuitBreakerSpy).toHaveBeenCalled();
      expect(setIdleSpy).toHaveBeenCalled();
      expect(clearModelsCacheSpy).toHaveBeenCalled();
      expect(publishSpy).toHaveBeenCalledWith(
        'session.reset',
        expect.objectContaining({ message: expect.any(String) }),
        expect.objectContaining({ channel: 'session:test-session' })
      );
      expect(startStreamingCalled).toBe(true);
    });

    test('preserves cost tracking during reset', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      mockContext.session.metadata = {
        lastSdkCost: 0.05,
        costBaseline: 0.1,
      };
      manager = new QueryLifecycleManager(mockContext);

      await manager.reset();

      // Should have updated metadata with preserved cost
      expect(updateSessionSpy).toHaveBeenCalled();
      expect(mockContext.session.metadata.costBaseline).toBeCloseTo(0.15, 10);
      expect(mockContext.session.metadata.lastSdkCost).toBe(0);
    });

    test('clears errors on reset', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.reset();

      expect(internalPublishSpy).toHaveBeenCalledWith('session.errorClear', {
        sessionId: 'test-session',
      });
    });

    test('skips restart when option is false', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      const result = await manager.reset({ restartAfter: false });

      expect(result.success).toBe(true);
      expect(startStreamingCalled).toBe(false);
    });

    test('no-restart reset drains delivery waiters; restart reset suppresses them (Codex P1)', async () => {
      // A no-restart reset is a TERMINAL idle (no startStreamingQuery follows):
      // the turn-end waiter must drain or driveDeliveryTurn hangs `processing`,
      // blocking the active-turn slot. A restart reset is a retry mid-point (the
      // query re-starts immediately after) → suppress the drain. The
      // post-stop setIdle gates suppressDeliveryWaiters on restartAfter.
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();

      manager = new QueryLifecycleManager(mockContext);
      await manager.reset({ restartAfter: false });
      expect(setIdleSpy).toHaveBeenCalledWith({ suppressDeliveryWaiters: false });

      // The first reset's stop() nulls queryObject/queryPromise; re-establish a
      // running query so the restart half exercises the post-stop setIdle (not
      // the no-query early-return path). Isolate the spy across halves.
      setIdleSpy.mockClear();
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);
      await manager.reset({ restartAfter: true });
      expect(setIdleSpy).toHaveBeenCalledWith({ suppressDeliveryWaiters: true });
    });

    test('a restartAfter reset that fails replacement startup releases the waiter (Codex P1)', async () => {
      // The suppressed idle (restartAfter) deferred the drain to the restart;
      // if cache-clear / resume-choice / startStreamingQuery then throws, the
      // catch must release the waiter or the durable turn hangs `processing`.
      const failingContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {}),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
        queryPromise: Promise.resolve(),
        startStreamingQuery: async () => {
          throw new Error('Start failed');
        },
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      const result = await failingManager.reset({ restartAfter: true });
      expect(result.success).toBe(false);
      expect(releaseIdleWaitersSpy).toHaveBeenCalledTimes(1);
    });

    test('returns error on failure', async () => {
      const failingContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {}),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
        queryPromise: Promise.resolve(),
        startStreamingQuery: async () => {
          throw new Error('Start failed');
        },
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      const result = await failingManager.reset({ restartAfter: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Start failed');
    });

    test('resets firstMessageReceived flag', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      mockContext.firstMessageReceived = true;
      manager = new QueryLifecycleManager(mockContext);

      await manager.reset();

      expect(mockContext.firstMessageReceived).toBe(false);
    });

    test('resets with default options', async () => {
      mockContext.queryObject = {
        interrupt: mock(async () => {}),
      } as unknown as QueryLifecycleManagerContext['queryObject'];
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      const result = await manager.reset();

      expect(result.success).toBe(true);
      // Default restartAfter is true
      expect(startStreamingCalled).toBe(true);
    });

    test('handles non-Error exceptions', async () => {
      const failingContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {}),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
        queryPromise: Promise.resolve(),
        startStreamingQuery: async () => {
          throw 'String error'; // eslint-disable-line @typescript-eslint/no-throw-literal
        },
      });
      const failingManager = new QueryLifecycleManager(failingContext);

      const result = await failingManager.reset({ restartAfter: true });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('edge cases', () => {
    test('handles concurrent stop calls', async () => {
      mockContext.queryPromise = new Promise((resolve) => setTimeout(resolve, 50));
      manager = new QueryLifecycleManager(mockContext);

      // Start two stops concurrently
      const [result1, result2] = await Promise.all([manager.stop(), manager.stop()]);

      // Both should complete without error
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
    });

    test('restart calls start after stop', async () => {
      // Verify the stop-then-start sequence in restart
      await manager.restart();
      expect(startStreamingCalled).toBe(true);
    });

    test('stop with undefined options uses defaults', async () => {
      await manager.stop();
      // Should complete without error using default timeout
    });
  });

  describe('ensureQueryStarted', () => {
    test('returns early if message queue is already running and queryPromise is active', async () => {
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext();
      // Set queryPromise to indicate an active query
      mockContext.queryPromise = Promise.resolve();
      manager = new QueryLifecycleManager(mockContext);

      await manager.ensureQueryStarted();

      expect(startStreamingCalled).toBe(false);
    });

    test('detects stale running state and restarts when isRunning=true but queryPromise=null', async () => {
      // Simulate stale state: messageQueue thinks it's running but queryPromise is null
      // This is a defensive check for edge cases (e.g., restored sessions with stale flags).
      // The primary race (between for-await loop ending and finally block) is handled by
      // the early messageQueue.stop() in QueryRunner.runQuery().
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext();
      // queryPromise is null (default) — this is the stale state
      mockContext.queryPromise = null;
      // Set a stale queryObject to verify it gets cleared
      mockContext.queryObject = { close: () => {} } as unknown as typeof mockContext.queryObject;
      manager = new QueryLifecycleManager(mockContext);

      const stopSpy = spyOn(messageQueue, 'stop');

      await manager.ensureQueryStarted();

      // Should have force-stopped the stale queue, cleared queryObject, and started a new query
      expect(stopSpy).toHaveBeenCalled();
      expect(mockContext.queryObject).toBeNull();
      expect(startStreamingCalled).toBe(true);
    });

    test('terminates orphaned tracked processes when recovering stale running state', async () => {
      // Clean-slate guard: stale running state (queue running, no queryPromise) is
      // usually an SDK subprocess that died without the queue being stopped — but it
      // may also be an orphan still holding the workspace lock. The recovery must
      // force-terminate the tracked set before starting a fresh query.
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext();
      mockContext.queryPromise = null;
      mockContext.queryObject = null;
      manager = new QueryLifecycleManager(mockContext);

      await manager.ensureQueryStarted();

      // Snapshot was taken and the tracked process group was asked to terminate.
      expect(snapshotTrackedAgentProcessesSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledWith({
        forceDelayMs: 2000,
        processes: [],
        noPidProcesses: [],
      });
      // Recovery still proceeds to start a fresh query.
      expect(startStreamingCalled).toBe(true);
    });

    test('does not clear a replacement query exit tracking when it replaces the orphan during recovery', async () => {
      // Codex P1 regression: during the stale-running recovery's bounded wait
      // for the orphaned process to exit, a concurrent ensureQueryStarted() can
      // start the replacement query, whose trackAgentProcess() installs a NEW
      // processExitedPromise. The recovery must only clear the exit tracking it
      // captured — clearing the replacement's would drop its exit tracking and
      // re-open the workspace-lock collision the guard exists to close.
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext();
      mockContext.queryPromise = null;
      mockContext.queryObject = null;

      // Orphan's exit promise resolves after a short delay (within the 5s cap).
      const orphanExit = new Promise<void>((resolve) => setTimeout(resolve, 30));
      mockContext.processExitedPromise = orphanExit;
      // The replacement query's exit promise — installed while recovery awaits.
      const replacementExit = new Promise<void>(() => {});
      setTimeout(() => {
        mockContext.processExitedPromise = replacementExit;
      }, 10);

      let resetCalled = false;
      mockContext.resetProcessExitedPromise = () => {
        resetCalled = true;
        mockContext.processExitedPromise = null;
      };

      manager = new QueryLifecycleManager(mockContext);
      await manager.ensureQueryStarted();

      // The orphan was awaited to completion, but the reset must NOT have fired
      // (the tracking no longer belongs to the orphan) and the replacement's
      // promise must be intact.
      expect(resetCalled).toBe(false);
      expect(mockContext.processExitedPromise).toBe(replacementExit);
      expect(startStreamingCalled).toBe(true);
    });

    test('starts streaming query when queue is not running', async () => {
      await manager.ensureQueryStarted();

      expect(startStreamingCalled).toBe(true);
    });

    test('clears models cache before starting streaming query', async () => {
      await manager.ensureQueryStarted();

      expect(clearModelsCacheSpy).toHaveBeenCalled();
    });

    test('validates SDK session when sdkSessionId exists and file is present', async () => {
      // When session has sdkSessionId and the file exists, query starts after validation.
      // This requires a temp dir so the file can be located by the file manager.
      const tmpTestDir = mkdtempSync(join(tmpdir(), 'kai-test-'));
      try {
        process.env.TEST_SDK_SESSION_DIR = tmpTestDir;
        const sdkSessionId = 'sdk-session-abc';
        // Create file at current workspace path
        const projectKey = '/test/workspace'.replace(/[/.]/g, '-');
        mkdirSync(join(tmpTestDir, 'projects', projectKey), { recursive: true });
        writeFileSync(join(tmpTestDir, 'projects', projectKey, `${sdkSessionId}.jsonl`), '');

        mockContext = createMockContext();
        mockContext.session.sdkSessionId = sdkSessionId;
        manager = new QueryLifecycleManager(mockContext);

        await manager.ensureQueryStarted();

        // File found → query should start
        expect(startStreamingCalled).toBe(true);
      } finally {
        delete process.env.TEST_SDK_SESSION_DIR;
        rmSync(tmpTestDir, { recursive: true, force: true });
      }
    });

    test('skips SDK transcript validation for ACP sessions with sdkSessionId', async () => {
      const tmpTestDir = mkdtempSync(join(tmpdir(), 'kai-test-'));
      try {
        process.env.TEST_SDK_SESSION_DIR = tmpTestDir;
        mockContext = createMockContext();
        mockContext.session.config.provider = 'acp';
        mockContext.session.sdkSessionId = 'missing-sdk-session';
        manager = new QueryLifecycleManager(mockContext);

        const result = await manager.ensureQueryStarted();

        expect(result).toBe('started');
        expect(startStreamingCalled).toBe(true);
        expect(saveHyperNeoActionMessageSpy).not.toHaveBeenCalled();
      } finally {
        delete process.env.TEST_SDK_SESSION_DIR;
        rmSync(tmpTestDir, { recursive: true, force: true });
      }
    });

    test('handles interrupt wait error gracefully', async () => {
      const rejectingPromise = Promise.reject(new Error('Interrupt error'));
      mockContext = createMockContext({
        interruptHandler: {
          getInterruptPromise: mock(() => rejectingPromise),
        } as unknown as InterruptHandler,
      });
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.ensureQueryStarted();
      expect(startStreamingCalled).toBe(true);
    });

    test('waits for pending interrupt before starting', async () => {
      let interruptResolved = false;
      const interruptPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          interruptResolved = true;
          resolve();
        }, 10);
      });
      getInterruptPromiseSpy = mock(() => interruptPromise);
      mockContext = createMockContext({
        interruptHandler: {
          getInterruptPromise: getInterruptPromiseSpy,
        } as unknown as InterruptHandler,
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.ensureQueryStarted();

      expect(interruptResolved).toBe(true);
      expect(startStreamingCalled).toBe(true);
    });

    test(
      'handles interrupt wait timeout',
      async () => {
        const neverResolves = new Promise<void>(() => {
          // Never resolves - tests the 5s timeout
        });
        mockContext = createMockContext({
          interruptHandler: {
            getInterruptPromise: mock(() => neverResolves),
          } as unknown as InterruptHandler,
        });
        manager = new QueryLifecycleManager(mockContext);

        // This should not hang due to the Promise.race with timeout
        const start = Date.now();
        await manager.ensureQueryStarted();
        const elapsed = Date.now() - start;

        // Should complete within reasonable time (5s timeout + some buffer)
        expect(elapsed).toBeLessThan(6000);
        expect(startStreamingCalled).toBe(true);
      },
      { timeout: 10000 }
    );
  });

  describe('startQueryAndEnqueue', () => {
    test('starts query and enqueues message', async () => {
      const enqueueSpy = spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');

      await manager.startQueryAndEnqueue('msg-123', 'Hello');

      expect(startStreamingCalled).toBe(true);
      expect(setQueuedSpy).toHaveBeenCalledWith('msg-123');
      expect(enqueueSpy).toHaveBeenCalledWith('msg-123', 'Hello');
    });

    test('emits message.sent event', async () => {
      spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');

      await manager.startQueryAndEnqueue('msg-123', 'Hello');

      expect(internalPublishSpy).toHaveBeenCalledWith('message.sent', {
        sessionId: 'test-session',
      });
    });

    test('handles message content array', async () => {
      const enqueueSpy = spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');
      const content = [{ type: 'text' as const, text: 'Hello' }];

      await manager.startQueryAndEnqueue('msg-123', content);

      expect(enqueueSpy).toHaveBeenCalledWith('msg-123', content);
    });

    test('keeps message queued when SDK resume choice blocks query startup', async () => {
      const tmpTestDir = mkdtempSync(join(tmpdir(), 'kai-test-'));
      try {
        process.env.TEST_SDK_SESSION_DIR = tmpTestDir;
        mockContext = createMockContext();
        mockContext.session.sdkSessionId = 'missing-sdk-session';
        manager = new QueryLifecycleManager(mockContext);
        const enqueueSpy = spyOn(messageQueue, 'enqueueWithId').mockResolvedValue('msg-123');

        await expect(manager.startQueryAndEnqueue('msg-123', 'Hello')).resolves.toBeUndefined();

        expect(startStreamingCalled).toBe(false);
        expect(saveHyperNeoActionMessageSpy).toHaveBeenCalled();
        expect(setQueuedSpy).toHaveBeenCalledWith('msg-123');
        expect(enqueueSpy).not.toHaveBeenCalled();
        expect(internalPublishSpy).not.toHaveBeenCalledWith('message.sent', {
          sessionId: 'test-session',
        });
      } finally {
        delete process.env.TEST_SDK_SESSION_DIR;
        rmSync(tmpTestDir, { recursive: true, force: true });
      }
    });

    test('ignores interrupted by user error', async () => {
      const interruptedError = new Error('Interrupted by user');
      spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(interruptedError);

      await manager.startQueryAndEnqueue('msg-123', 'Hello');

      // Give time for the catch handler to execute
      await new Promise((r) => setTimeout(r, 10));

      // Should not call handleError for user interruption
      expect(handleErrorSpy).not.toHaveBeenCalled();
    });

    test('handles timeout error with reset and retry', async () => {
      const timeoutError = new Error('Queue timeout');
      timeoutError.name = 'MessageQueueTimeoutError';

      let callCount = 0;
      spyOn(messageQueue, 'enqueueWithId').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw timeoutError;
        }
        return 'msg-123';
      });

      await manager.startQueryAndEnqueue('msg-123', 'Hello');

      // Give time for the catch handler to execute
      await new Promise((r) => setTimeout(r, 200));

      // Should have called handleError with TIMEOUT category
      expect(handleErrorSpy).toHaveBeenCalled();
      // Should have retried enqueue after reset
      expect(callCount).toBe(2);
    });

    test('handles non-timeout delivery error by setting idle asynchronously', async () => {
      const regularError = new Error('Some error');
      spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(regularError);

      await manager.startQueryAndEnqueue('msg-123', 'Hello');
      await new Promise((r) => setTimeout(r, 10));

      // Should have called handleError
      expect(handleErrorSpy).toHaveBeenCalled();
      // Should set idle after non-timeout error
      expect(setIdleSpy).toHaveBeenCalled();
    });

    test('sets idle when reset fails during timeout handling', async () => {
      const timeoutError = new Error('Queue timeout');
      timeoutError.name = 'MessageQueueTimeoutError';

      // First call throws timeout, subsequent calls also fail
      spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);

      // Reset will fail because startStreamingQuery fails on second call
      let callCount = 0;
      mockContext = createMockContext({
        startStreamingQuery: async () => {
          callCount++;
          if (callCount > 1) {
            throw new Error('Reset failed');
          }
          messageQueue.start();
          mockContext.queryPromise = Promise.resolve();
        },
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.startQueryAndEnqueue('msg-123', 'Hello');
      await new Promise((r) => setTimeout(r, 200));

      // Should set idle after reset failure
      expect(setIdleSpy).toHaveBeenCalled();
    });

    test('sets idle when retry fails after successful reset', async () => {
      const timeoutError = new Error('Queue timeout');
      timeoutError.name = 'MessageQueueTimeoutError';

      // Always throw timeout error
      spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);

      await manager.startQueryAndEnqueue('msg-123', 'Hello');
      await new Promise((r) => setTimeout(r, 200));

      // Should set idle after retry fails
      expect(setIdleSpy).toHaveBeenCalled();
    });

    test('marks enqueued message failed when timeout retry fails', async () => {
      const timeoutError = new Error('Queue timeout');
      timeoutError.name = 'MessageQueueTimeoutError';

      spyOn(messageQueue, 'enqueueWithId').mockRejectedValue(timeoutError);
      const resetSpy = spyOn(manager, 'reset');

      await manager.startQueryAndEnqueue('msg-123', 'Hello');
      await new Promise((r) => setTimeout(r, 200));

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(updateMessageStatusSpy).toHaveBeenCalledWith(['db-msg-123'], 'failed');
      expect(internalPublishSpy).toHaveBeenCalledWith(
        'messages.statusChanged',
        expect.objectContaining({
          sessionId: 'test-session',
          messageIds: ['db-msg-123'],
          status: 'failed',
        })
      );
      expect(setIdleSpy).toHaveBeenCalled();
    });
  });

  describe('restartQuery', () => {
    test('returns early if message queue is not running', async () => {
      // Queue is not running by default
      await manager.restartQuery();

      expect(startStreamingCalled).toBe(false);
    });

    test('returns early if no query object exists', async () => {
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext({
        queryObject: null,
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.restartQuery();

      expect(startStreamingCalled).toBe(false);
    });

    test('defers restart when processing', async () => {
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {}),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
      });
      getStateSpy = mock(() => ({ status: 'processing' }));
      mockContext.stateManager = {
        setIdle: setIdleSpy,
        setQueued: setQueuedSpy,
        getState: getStateSpy,
      } as unknown as ProcessingStateManager;
      manager = new QueryLifecycleManager(mockContext);

      await manager.restartQuery();

      expect(mockContext.pendingRestartReason).toBe('settings.local.json');
      expect(startStreamingCalled).toBe(false);
    });

    test('restarts immediately when idle', async () => {
      messageQueue.start(async function* () {
        yield 'test';
      });
      mockContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {}),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
      });
      getStateSpy = mock(() => ({ status: 'idle' }));
      mockContext.stateManager = {
        setIdle: setIdleSpy,
        setQueued: setQueuedSpy,
        getState: getStateSpy,
      } as unknown as ProcessingStateManager;
      manager = new QueryLifecycleManager(mockContext);

      await manager.restartQuery();

      expect(startStreamingCalled).toBe(true);
    });
  });

  describe('executeDeferredRestartIfPending', () => {
    test('returns early if no pending restart reason', async () => {
      mockContext.pendingRestartReason = null;
      manager = new QueryLifecycleManager(mockContext);

      await manager.executeDeferredRestartIfPending();

      expect(startStreamingCalled).toBe(false);
    });

    test('executes restart when pending reason exists', async () => {
      mockContext.pendingRestartReason = 'settings.local.json';
      manager = new QueryLifecycleManager(mockContext);

      await manager.executeDeferredRestartIfPending();

      expect(mockContext.pendingRestartReason).toBeNull();
      expect(startStreamingCalled).toBe(true);
    });

    test('clears pending reason even if restart fails', async () => {
      mockContext = createMockContext({
        pendingRestartReason: 'settings.local.json',
        startStreamingQuery: async () => {
          throw new Error('Restart failed');
        },
      });
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.executeDeferredRestartIfPending();

      expect(mockContext.pendingRestartReason).toBeNull();
    });
  });

  describe('cleanup', () => {
    test('sets cleaningUp flag', async () => {
      const setCleaningUpSpy = mock(() => {});
      mockContext = createMockContext({
        setCleaningUp: setCleaningUpSpy,
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.cleanup();

      expect(setCleaningUpSpy).toHaveBeenCalledWith(true);
    });

    test('cleans up event subscriptions', async () => {
      const cleanupEventSubscriptionsSpy = mock(() => {});
      mockContext = createMockContext({
        cleanupEventSubscriptions: cleanupEventSubscriptionsSpy,
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.cleanup();

      expect(cleanupEventSubscriptionsSpy).toHaveBeenCalled();
    });

    test('clears models cache', async () => {
      const clearModelsCacheSpy = mock(async () => {});
      mockContext = createMockContext({
        clearModelsCache: clearModelsCacheSpy,
      });
      manager = new QueryLifecycleManager(mockContext);

      await manager.cleanup();

      expect(clearModelsCacheSpy).toHaveBeenCalled();
    });

    test('handles clearModelsCache error gracefully', async () => {
      const clearModelsCacheSpy = mock(async () => {
        throw new Error('Cache clear failed');
      });
      mockContext = createMockContext({
        clearModelsCache: clearModelsCacheSpy,
      });
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.cleanup();

      expect(clearModelsCacheSpy).toHaveBeenCalled();
    });

    test('stops query with extended timeout', async () => {
      const stopSpy = spyOn(messageQueue, 'stop');
      mockContext = createMockContext();
      manager = new QueryLifecycleManager(mockContext);

      await manager.cleanup();

      expect(stopSpy).toHaveBeenCalled();
    });

    test('handles stop error gracefully', async () => {
      mockContext = createMockContext({
        queryObject: {
          interrupt: mock(async () => {
            throw new Error('Interrupt failed');
          }),
        } as unknown as QueryLifecycleManagerContext['queryObject'],
        queryPromise: Promise.reject(new Error('Query failed')),
        firstMessageReceived: true,
      });
      manager = new QueryLifecycleManager(mockContext);

      // Should not throw
      await manager.cleanup();
    });
  });

  /**
   * Regression tests for the worktree path fix (PR #518).
   *
   * The SDK subprocess uses its CWD (worktree path for worktree sessions) to
   * determine where to write .jsonl session files. Before the fix, all 3 call
   * sites that validate/repair the SDK session file used session.workspacePath,
   * causing lookups to search the wrong directory and falsely clear sdkSessionId.
   *
   * Each method that calls validateAndRepairSDKSession gets its own sub-block.
   */
  describe('SDK workspace path resolution', () => {
    let tmpDir: string;

    /**
     * Helper: create a valid (empty) JSONL fixture at the given path.
     * An empty file passes validateAndRepairSDKSession (no orphaned tool_results).
     */
    function createSdkFile(basePath: string, sdkSessionId: string): void {
      const projectKey = basePath.replace(/[/.]/g, '-');
      const sessionDir = join(tmpDir, 'projects', projectKey);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${sdkSessionId}.jsonl`), '');
    }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'kai-test-'));
      process.env.TEST_SDK_SESSION_DIR = tmpDir;
    });

    afterEach(() => {
      delete process.env.TEST_SDK_SESSION_DIR;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('restart()', () => {
      test(
        'uses worktreePath when session has worktree — preserves sdkSessionId',
        async () => {
          const sdkSessionId = 'sdk-restart-worktree';
          const worktreePath = '/worktree/path';
          createSdkFile(worktreePath, sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath,
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          manager = new QueryLifecycleManager(mockContext);

          await manager.restart();

          // File found at worktree path → sdkSessionId preserved
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );

      test(
        'uses workspacePath when no worktree — preserves sdkSessionId',
        async () => {
          const sdkSessionId = 'sdk-restart-workspace';
          createSdkFile('/test/workspace', sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          // No worktree set
          manager = new QueryLifecycleManager(mockContext);

          await manager.restart();

          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );

      test(
        'preserves sdkSessionId when file is at workspacePath but session has worktree',
        async () => {
          const sdkSessionId = 'sdk-restart-wrong-dir';
          // File is at workspacePath, NOT at worktreePath
          createSdkFile('/test/workspace', sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath: '/worktree/path',
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          manager = new QueryLifecycleManager(mockContext);

          await manager.restart();

          // sdkSessionId preserved — SDK will attempt recovery on next query
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );
    });

    describe('reset()', () => {
      test(
        'uses worktreePath when session has worktree — preserves sdkSessionId',
        async () => {
          const sdkSessionId = 'sdk-reset-worktree';
          const worktreePath = '/worktree/path';
          createSdkFile(worktreePath, sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath,
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          mockContext.queryObject = {
            interrupt: mock(async () => {}),
          } as unknown as QueryLifecycleManagerContext['queryObject'];
          mockContext.queryPromise = Promise.resolve();
          manager = new QueryLifecycleManager(mockContext);

          await manager.reset({ restartAfter: true });

          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );

      test(
        'preserves sdkSessionId when file is at workspacePath but session has worktree',
        async () => {
          const sdkSessionId = 'sdk-reset-wrong-dir';
          createSdkFile('/test/workspace', sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath: '/worktree/path',
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          mockContext.queryObject = {
            interrupt: mock(async () => {}),
          } as unknown as QueryLifecycleManagerContext['queryObject'];
          mockContext.queryPromise = Promise.resolve();
          manager = new QueryLifecycleManager(mockContext);

          await manager.reset({ restartAfter: true });

          // sdkSessionId preserved — SDK will attempt recovery on next query
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );
    });

    describe('ensureQueryStarted()', () => {
      test(
        'uses worktreePath when session has worktree — preserves sdkSessionId',
        async () => {
          const sdkSessionId = 'sdk-ensure-worktree';
          const worktreePath = '/worktree/path';
          createSdkFile(worktreePath, sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath,
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );

      test(
        'preserves sdkSessionId when file is at workspacePath but session has worktree',
        async () => {
          const sdkSessionId = 'sdk-ensure-wrong-dir';
          createSdkFile('/test/workspace', sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath: '/worktree/path',
            branch: 'session/test',
            mainRepoPath: '/test/workspace',
          };
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          // sdkSessionId preserved — SDK will attempt recovery on next query
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );
    });

    /**
     * Regression tests for Task #12: cross-workspace / worktree resume.
     *
     * When a session's effective CWD changes between daemon restarts (e.g. a worktree
     * is added after the session was created), the SDK session file lives under the
     * OLD project directory. The fix locates and migrates the file before resume.
     */
    describe('cross-workspace resume (Task #12)', () => {
      test(
        'migrates session file from sdkOriginPath to current CWD when they differ',
        async () => {
          const sdkSessionId = 'sdk-migrate-origin-path';
          const originWorkspace = '/origin/workspace';
          const currentWorktree = '/current/worktree';

          // File exists at the origin workspace's project dir
          createSdkFile(originWorkspace, sdkSessionId);

          // Session has sdkOriginPath = origin, but worktree CWD = current
          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.sdkOriginPath = originWorkspace;
          mockContext.session.worktree = {
            isWorktree: true,
            worktreePath: currentWorktree,
            branch: 'feature/test',
            mainRepoPath: originWorkspace,
          };
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          // sdkSessionId preserved (migration succeeded)
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);

          // sdkOriginPath updated to current worktree path after migration
          expect(mockContext.session.sdkOriginPath).toBe(currentWorktree);

          // DB updated with new sdkOriginPath
          expect(updateSessionSpy).toHaveBeenCalledWith('test-session', {
            sdkOriginPath: currentWorktree,
          });
        },
        { timeout: 5000 }
      );

      test(
        'finds session file via global scan when sdkOriginPath is not set (legacy sessions)',
        async () => {
          const sdkSessionId = 'sdk-global-scan-legacy';
          // Simulate a legacy session: file is at workspace path, no sdkOriginPath stored
          const legacyWorkspace = '/legacy/workspace';
          createSdkFile(legacyWorkspace, sdkSessionId);

          // Session has sdkSessionId but no sdkOriginPath (pre-fix session)
          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.sdkOriginPath = undefined;
          // No worktree — current workspace differs from where the file is
          mockContext.session.workspacePath = '/new/different/workspace';
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          // sdkSessionId preserved — global scan found and migrated the file
          expect(mockContext.session.sdkSessionId).toBe(sdkSessionId);
        },
        { timeout: 5000 }
      );

      test(
        'blocks query and emits sdk_resume_choice action when transcript file not found anywhere',
        async () => {
          // sdkSessionId set but no file exists anywhere under TEST_SDK_SESSION_DIR
          mockContext.session.sdkSessionId = 'sdk-completely-missing';
          mockContext.session.sdkOriginPath = '/some/deleted/workspace';
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          // Query must NOT start — user must choose first
          expect(startStreamingCalled).toBe(false);

          // A sdk_resume_choice action message must be saved to DB
          expect(saveHyperNeoActionMessageSpy).toHaveBeenCalledTimes(1);
          const savedMsg = saveHyperNeoActionMessageSpy.mock.calls[0][1];
          expect(savedMsg.type).toBe('hyperneo_action');
          expect(savedMsg.action).toBe('sdk_resume_choice');
          expect(savedMsg.resolved).toBe(false);
          expect(savedMsg.session_id).toBe('test-session');

          // The action message must be broadcast via state.sdkMessages.delta
          expect(publishSpy).toHaveBeenCalledWith(
            'state.sdkMessages.delta',
            expect.objectContaining({
              added: expect.arrayContaining([
                expect.objectContaining({
                  type: 'hyperneo_action',
                  action: 'sdk_resume_choice',
                }),
              ]),
            }),
            expect.objectContaining({ channel: 'session:test-session' })
          );
        },
        { timeout: 5000 }
      );

      test(
        'sets sdkOriginPath for sessions that have the file at current workspace but no origin recorded',
        async () => {
          const sdkSessionId = 'sdk-set-origin-on-existing';
          // File exists at the current workspace (e.g., session was created here)
          createSdkFile('/test/workspace', sdkSessionId);

          mockContext.session.sdkSessionId = sdkSessionId;
          mockContext.session.sdkOriginPath = undefined; // not set yet
          // No worktree — current workspace = /test/workspace (from createMockContext)
          manager = new QueryLifecycleManager(mockContext);

          await manager.ensureQueryStarted();

          // sdkOriginPath should now be set to the current workspace
          expect(mockContext.session.sdkOriginPath).toBe('/test/workspace');

          // DB updated
          expect(updateSessionSpy).toHaveBeenCalledWith('test-session', {
            sdkOriginPath: '/test/workspace',
          });
        },
        { timeout: 5000 }
      );
    });
  });
});
