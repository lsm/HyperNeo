/**
 * InterruptHandler Tests
 *
 * Tests for query interrupt handling.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  InterruptHandler,
  type InterruptHandlerContext,
} from '../../../../src/lib/agent/interrupt-handler';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Session, MessageHub } from '@hyperneo/shared';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { Logger } from '../../../../src/lib/logger';

describe('InterruptHandler', () => {
  let handler: InterruptHandler;
  let mockSession: Session;
  let mockMessageHub: MessageHub;
  let mockMessageQueue: MessageQueue;
  let mockStateManager: ProcessingStateManager;
  let mockLogger: Logger;
  let mockQueryObject: Query | null;
  let mockAbortController: AbortController | null;
  let mockQueryPromise: Promise<void> | null;

  let publishSpy: ReturnType<typeof mock>;
  let setInterruptedSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let queueSizeSpy: ReturnType<typeof mock>;
  let queueClearSpy: ReturnType<typeof mock>;
  let queueStopSpy: ReturnType<typeof mock>;
  let sdkInterruptSpy: ReturnType<typeof mock>;
  let sdkCloseSpy: ReturnType<typeof mock>;
  let cancelForSessionSpy: ReturnType<typeof mock>;
  let markFailedSpy: ReturnType<typeof mock>;
  let mockDb: InterruptHandlerContext['db'];
  let busPublishAsyncSpy: ReturnType<typeof mock>;
  let mockEventBus: InterruptHandlerContext['internalEventBus'];

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      status: 'active',
      config: { model: 'claude-sonnet-4-20250514' },
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Session;

    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    queueSizeSpy = mock(() => 0);
    queueClearSpy = mock(() => {});
    queueStopSpy = mock(() => {});
    mockMessageQueue = {
      size: queueSizeSpy,
      clear: queueClearSpy,
      stop: queueStopSpy,
    } as unknown as MessageQueue;

    setInterruptedSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    getStateSpy = mock(() => ({ status: 'processing', phase: 'streaming' }));
    mockStateManager = {
      setInterrupted: setInterruptedSpy,
      setIdle: setIdleSpy,
      getState: getStateSpy,
    } as unknown as ProcessingStateManager;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    sdkInterruptSpy = mock(async () => {});
    sdkCloseSpy = mock(() => {});
    mockQueryObject = {
      interrupt: sdkInterruptSpy,
      close: sdkCloseSpy,
    } as unknown as Query;

    mockAbortController = new AbortController();
    mockQueryPromise = null;

    // Default: no durable delivery jobs (legacy path — the cancel is a no-op).
    cancelForSessionSpy = mock(() => [] as string[]);
    markFailedSpy = mock(() => null);
    mockDb = {
      getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
      getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
      getMessagesByStatus: mock(() => []),
      notifyChange: mock(() => {}),
    } as unknown as InterruptHandlerContext['db'];

    busPublishAsyncSpy = mock(async () => {});
    mockEventBus = {
      publishAsync: busPublishAsyncSpy,
      publish: mock(async () => {}),
    } as unknown as InterruptHandlerContext['internalEventBus'];
  });

  function createContext(
    overrides: Partial<InterruptHandlerContext> = {}
  ): InterruptHandlerContext {
    return {
      session: mockSession,
      messageHub: mockMessageHub,
      messageQueue: mockMessageQueue,
      stateManager: mockStateManager,
      logger: mockLogger,
      db: mockDb,
      internalEventBus: mockEventBus,
      queryObject: mockQueryObject,
      queryPromise: mockQueryPromise,
      queryAbortController: mockAbortController,
      processExitedPromise: null,
      ...overrides,
    };
  }

  function createHandler(overrides: Partial<InterruptHandlerContext> = {}): InterruptHandler {
    return new InterruptHandler(createContext(overrides));
  }

  describe('constructor', () => {
    it('should create handler with dependencies', () => {
      handler = createHandler();
      expect(handler).toBeDefined();
    });
  });

  describe('getInterruptPromise', () => {
    it('should return null when no interrupt is in progress', () => {
      handler = createHandler();
      expect(handler.getInterruptPromise()).toBeNull();
    });
  });

  describe('handleInterrupt', () => {
    it('should skip interrupt if already idle', async () => {
      getStateSpy.mockReturnValue({ status: 'idle' });
      handler = createHandler();

      await handler.handleInterrupt();

      expect(setInterruptedSpy).not.toHaveBeenCalled();
    });

    it('should skip interrupt if already interrupted', async () => {
      getStateSpy.mockReturnValue({ status: 'interrupted' });
      handler = createHandler();

      await handler.handleInterrupt();

      expect(setInterruptedSpy).not.toHaveBeenCalled();
    });

    it('should set state to interrupted', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(setInterruptedSpy).toHaveBeenCalled();
    });

    it('should clear message queue if has pending messages', async () => {
      queueSizeSpy.mockReturnValue(5);
      handler = createHandler();

      await handler.handleInterrupt();

      expect(queueClearSpy).toHaveBeenCalled();
    });

    it('should abort the query controller', async () => {
      const abortController = new AbortController();
      const ctx = createContext({ queryAbortController: abortController });
      handler = new InterruptHandler(ctx);

      await handler.handleInterrupt();

      expect(abortController.signal.aborted).toBe(true);
      expect(ctx.queryAbortController).toBeNull();
    });

    it('should call SDK interrupt()', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(sdkInterruptSpy).toHaveBeenCalled();
    });

    it('cancels ALL durable deliveries before anything else (#3743968030/#3744105273)', async () => {
      cancelForSessionSpy = mock(() => ['turn-uuid', 'steer-uuid']);
      mockDb = {
        getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
        getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
      } as unknown as InterruptHandlerContext['db'];
      const callOrder: string[] = [];
      cancelForSessionSpy.mockImplementation(() => {
        callOrder.push('cancel');
        return ['turn-uuid', 'steer-uuid'];
      });
      setInterruptedSpy.mockImplementation(async () => {
        callOrder.push('setInterrupted');
      });
      handler = createHandler({ db: mockDb });

      await handler.handleInterrupt();

      expect(cancelForSessionSpy).toHaveBeenCalledWith('test-session-id');
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'turn-uuid');
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'steer-uuid');
      // The durable cancel runs BEFORE the state flip — a processor claiming a
      // job while the interrupt unwinds must find it already gone.
      expect(callOrder).toEqual(['cancel', 'setInterrupted']);
    });

    it('notifies the delivery feeds (sdk_messages + job_queue) after cancelling deliveries (#862 review P1)', async () => {
      // cancelForSessionWithMessages (raw DELETE job_queue) and
      // markDeliveryFailedByUuid (raw UPDATE sdk_messages) write without a
      // notify, so without the explicit notifyChange the queued/retrying badge
      // would stay stuck after an interrupt until an unrelated write/reconnect.
      const notifySpy = mock(() => {});
      cancelForSessionSpy = mock(() => ['turn-uuid']);
      mockDb = {
        getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
        getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
        notifyChange: notifySpy,
      } as unknown as InterruptHandlerContext['db'];
      handler = createHandler({ db: mockDb });

      await handler.handleInterrupt();

      expect(notifySpy).toHaveBeenCalledWith('sdk_messages', { sessionId: 'test-session-id' });
      expect(notifySpy).toHaveBeenCalledWith('job_queue', { sessionId: 'test-session-id' });
    });

    it('cancels durable deliveries even when the session is already idle', async () => {
      getStateSpy.mockReturnValue({ status: 'idle', phase: 'idle' });
      cancelForSessionSpy = mock(() => ['pre-claim-uuid']);
      mockDb = {
        getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
        getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
      } as unknown as InterruptHandlerContext['db'];
      handler = createHandler({ db: mockDb });

      await handler.handleInterrupt();

      // The pre-claim window can leave a durable job pending while the state
      // reads idle — the cancel must run before the idle early-return.
      expect(cancelForSessionSpy).toHaveBeenCalledWith('test-session-id');
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'pre-claim-uuid');
    });

    it('terminalizes enqueued orphan rows (no active job) so a Stop is not undone by the post-interrupt idle reconcile (#861)', async () => {
      // An enqueued user row with NO active durable job isn't returned by
      // cancelForSessionWithMessages. Without terminalizing it here, the idle
      // reconcileStrandedDeliveries would re-enqueue it — restarting a prompt
      // the user just stopped.
      cancelForSessionSpy = mock(() => ['active-uuid']);
      const orphan = { uuid: 'orphan-uuid' };
      const getMessagesByStatusSpy = mock((_sid: string, status: string) =>
        status === 'enqueued' ? [orphan] : []
      );
      mockDb = {
        getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
        getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
        getMessagesByStatus: getMessagesByStatusSpy,
      } as unknown as InterruptHandlerContext['db'];
      handler = createHandler({ db: mockDb });

      await handler.handleInterrupt();

      // The active-job UUID is terminalized…
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'active-uuid');
      // …and so is the enqueued orphan (not in the cancelled set).
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'orphan-uuid');
    });

    it('should handle SDK interrupt() failure gracefully', async () => {
      sdkInterruptSpy.mockRejectedValue(new Error('Interrupt failed'));
      handler = createHandler();

      await handler.handleInterrupt();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SDK interrupt() failed'),
        'Interrupt failed'
      );
    });

    it('should handle missing query object gracefully', async () => {
      handler = createHandler({ queryObject: null });

      await handler.handleInterrupt();

      expect(sdkInterruptSpy).not.toHaveBeenCalled();
    });

    it('should wait for old query to finish', async () => {
      const queryPromise = new Promise<void>((resolve) => setTimeout(resolve, 10));
      handler = createHandler({ queryPromise });

      await handler.handleInterrupt();
    });

    it('should handle error waiting for old query', async () => {
      const queryPromise = Promise.reject(new Error('Query error'));
      handler = createHandler({ queryPromise });

      await handler.handleInterrupt();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Error waiting for old query'),
        expect.any(Error)
      );
    });

    it('should clear queryObject reference', async () => {
      const ctx = createContext();
      handler = new InterruptHandler(ctx);

      await handler.handleInterrupt();

      expect(ctx.queryObject).toBeNull();
    });

    it('should stop the message queue', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(queueStopSpy).toHaveBeenCalled();
    });

    it('should publish session.interrupted event', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(publishSpy).toHaveBeenCalledWith(
        'session.interrupted',
        {},
        { channel: 'session:test-session-id' }
      );
    });

    it('should set state back to idle', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should publish query.trigger after interrupt completion to replay deferred rows', async () => {
      // The interrupt path reaches idle WITHOUT the query.trigger that
      // SDKMessageHandler.finishTurn publishes on normal turn end, so a row
      // persisted as 'deferred' while the session was processing (e.g. an
      // external event in 'defer' mode) would sit unconsumed indefinitely.
      // The interrupt→idle transition must drive the deferred queue itself.
      handler = createHandler();

      await handler.handleInterrupt();
      // The post-interrupt state is idle (setIdle just ran) — the fire-time
      // recheck requires it. The trigger is scheduled through the
      // query-settled + process-exit gate, so it fires on the next tick even
      // when both are already settled.
      getStateSpy.mockReturnValue({ status: 'idle' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(busPublishAsyncSpy).toHaveBeenCalledWith('query.trigger', {
        sessionId: 'test-session-id',
      });
    });

    it('should not publish query.trigger in manual query mode', async () => {
      handler = createHandler({
        session: {
          ...mockSession,
          config: { ...mockSession.config, queryMode: 'manual' },
        } as Session,
      });

      await handler.handleInterrupt();

      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('should skip query.trigger for teardown-bound interrupts', async () => {
      // stopSessionPreserveDb (task cancellation/completion/shutdown) must not
      // drive the deferred queue: replaying would promote deferred rows to
      // enqueued and create delivery jobs for a session about to be cleaned up.
      handler = createHandler();

      await handler.handleInterrupt({ skipDeferredReplay: true });

      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('should honor teardown suppression in the delayed replay path', async () => {
      // When the teardown-bound interrupt's 200ms settle wait times out, the
      // delayed callback must ALSO honor skipDeferredReplay — otherwise it
      // publishes query.trigger after teardown has proceeded, promoting
      // deferred rows and creating delivery jobs for a dead session.
      let settleOldQuery!: () => void;
      const queryPromise = new Promise<void>((resolve) => {
        settleOldQuery = resolve;
      });
      handler = createHandler({ queryPromise });

      await handler.handleInterrupt({ skipDeferredReplay: true });

      settleOldQuery();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('should delay query.trigger until the old query exits when the wait times out', async () => {
      // The interrupt wait races the old queryPromise against 200ms; when the
      // query is still unwinding, replaying immediately could launch a
      // replacement query while the old subprocess is still alive.
      let settleOldQuery!: () => void;
      const queryPromise = new Promise<void>((resolve) => {
        settleOldQuery = resolve;
      });
      handler = createHandler({ queryPromise });

      const interrupted = handler.handleInterrupt();
      // Let the 200ms race time out and the interrupt flow finish; the old
      // query has NOT settled, so no replay yet.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();

      settleOldQuery();
      await interrupted;
      // Post-interrupt idle — required by the fire-time recheck.
      getStateSpy.mockReturnValue({ status: 'idle' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).toHaveBeenCalledWith('query.trigger', {
        sessionId: 'test-session-id',
      });
    });

    it('lets a later teardown request suppress an in-flight interrupt replay', async () => {
      // interruptBySessionId quiesce (skipDeferredReplay) arriving while a
      // user interrupt is already in flight: the teardown invocation
      // early-returns on the shared 'interrupted' state, so suppression must
      // be recorded where the in-flight interrupt's scheduled replay can
      // observe it at fire time.
      let settleOldQuery!: () => void;
      const queryPromise = new Promise<void>((resolve) => {
        settleOldQuery = resolve;
      });
      let status = 'processing';
      getStateSpy.mockImplementation(() => ({ status, phase: 'streaming' }));
      setInterruptedSpy.mockImplementation(async () => {
        status = 'interrupted';
      });
      handler = createHandler({ queryPromise });

      const interrupted = handler.handleInterrupt(); // user interrupt, in flight
      await new Promise((resolve) => setTimeout(resolve, 30));
      await handler.handleInterrupt({ skipDeferredReplay: true }); // teardown, early-returns

      settleOldQuery();
      await interrupted;
      status = 'idle'; // interrupt resolved; no newer turn
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('skips the delayed replay when a newer turn started before the process exited', async () => {
      // While the gate waits for the old subprocess to exit, the interrupt has
      // already exposed idle — a newer turn can start. Publishing then would
      // steer the old deferred rows into that active turn; replay is left to
      // the newer turn's own completion.
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      let status = 'processing';
      getStateSpy.mockImplementation(() => ({ status }));
      handler = createHandler({ processExitedPromise });

      await handler.handleInterrupt();
      status = 'idle'; // post-interrupt idle; gate still pending on process exit
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = 'processing'; // a newer turn starts before the process exits
      signalProcessExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('should delay query.trigger until the subprocess exits even when the query settled in time', async () => {
      // Query settlement is not a subprocess-exit guarantee
      // (QueryLifecycleManager.stop separately awaits processExitedPromise);
      // the replay must wait for both or the replacement query can race the
      // old process holding workspace resources.
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      handler = createHandler({ processExitedPromise });

      await handler.handleInterrupt();
      // The (absent) query settled instantly, but the subprocess has not
      // exited — no replay yet.
      getStateSpy.mockReturnValue({ status: 'idle' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();

      signalProcessExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).toHaveBeenCalledWith('query.trigger', {
        sessionId: 'test-session-id',
      });
    });

    it('should resolve interrupt promise in finally block', async () => {
      handler = createHandler();

      // Verify interrupt promise is resolved
      const interruptComplete = handler.handleInterrupt();
      await interruptComplete;

      // Promise should be cleared
      expect(handler.getInterruptPromise()).toBeNull();
    });

    it('should handle query object without interrupt method', async () => {
      handler = createHandler({ queryObject: {} as Query }); // No interrupt method

      await handler.handleInterrupt();

      // Should not throw
      expect(handler).toBeDefined();
    });

    it('should call SDK close() to terminate subprocess and MCP transports', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(sdkCloseSpy).toHaveBeenCalled();
    });

    it('should call close() after interrupt() and waiting for query promise', async () => {
      const callOrder: string[] = [];
      sdkInterruptSpy.mockImplementation(async () => {
        callOrder.push('interrupt');
      });
      sdkCloseSpy.mockImplementation(() => {
        callOrder.push('close');
      });
      const queryPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          callOrder.push('promise');
          resolve();
        }, 10);
      });
      handler = createHandler({ queryPromise });

      await handler.handleInterrupt();

      const interruptIdx = callOrder.indexOf('interrupt');
      const promiseIdx = callOrder.indexOf('promise');
      const closeIdx = callOrder.indexOf('close');
      expect(interruptIdx).not.toBe(-1);
      expect(promiseIdx).not.toBe(-1);
      expect(closeIdx).not.toBe(-1);
      expect(interruptIdx).toBeLessThan(promiseIdx);
      expect(promiseIdx).toBeLessThan(closeIdx);
    });

    it('should handle SDK close() failure gracefully', async () => {
      sdkCloseSpy.mockImplementation(() => {
        throw new Error('Close failed');
      });
      handler = createHandler();

      // Should not throw
      await handler.handleInterrupt();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SDK close() failed'),
        'Close failed'
      );
    });

    it('should skip close() when queryObject is null', async () => {
      handler = createHandler({ queryObject: null });

      // Should not throw
      await handler.handleInterrupt();

      expect(sdkCloseSpy).not.toHaveBeenCalled();
    });
  });
});
