import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  InterruptHandler,
  type InterruptHandlerContext,
} from '../../../../src/lib/agent/interrupt-handler';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Session, MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  MESSAGE_DELIVERY,
  MESSAGE_DELIVERY_MAX_RETRIES,
} from '../../../../src/lib/agent/message-delivery';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { Logger } from '../../../../src/lib/logger';
import { createTestDb, createTestSession } from '../../../helpers/database';

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
  let queueNoteUserInterruptSpy: ReturnType<typeof mock>;
  let sdkInterruptSpy: ReturnType<typeof mock>;
  let sdkCancelAsyncMessageSpy: ReturnType<typeof mock>;
  let sdkCloseSpy: ReturnType<typeof mock>;
  let getSdkCapabilitiesSpy: ReturnType<typeof mock>;
  let cancelForSessionSpy: ReturnType<typeof mock>;
  let markFailedSpy: ReturnType<typeof mock>;
  let mockDb: InterruptHandlerContext['db'];
  let busPublishAsyncSpy: ReturnType<typeof mock>;
  let busPublishSpy: ReturnType<typeof mock>;
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
    queueNoteUserInterruptSpy = mock(() => {});
    mockMessageQueue = {
      size: queueSizeSpy,
      clear: queueClearSpy,
      stop: queueStopSpy,
      noteUserInterrupt: queueNoteUserInterruptSpy,
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
    sdkCancelAsyncMessageSpy = mock(async () => true);
    sdkCloseSpy = mock(() => {});
    mockQueryObject = {
      interrupt: sdkInterruptSpy,
      cancelAsyncMessage: sdkCancelAsyncMessageSpy,
      close: sdkCloseSpy,
    } as unknown as Query;

    getSdkCapabilitiesSpy = mock(() => new Set<string>());

    mockAbortController = new AbortController();
    mockQueryPromise = null;

    cancelForSessionSpy = mock(() => [] as string[]);
    markFailedSpy = mock(() => null);
    mockDb = {
      getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
      getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
      getUserMessageIdsByStatus: mock(() => []),
      notifyChange: mock(() => {}),
    } as unknown as InterruptHandlerContext['db'];

    busPublishAsyncSpy = mock(async () => {});
    busPublishSpy = mock(async () => {});
    mockEventBus = {
      publishAsync: busPublishAsyncSpy,
      publish: busPublishSpy,
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
      getSdkCapabilities: getSdkCapabilitiesSpy,
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

  describe('isInterruptRequested', () => {
    it('marks the interrupt as requested synchronously before the first await', async () => {
      let releaseInterrupted!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseInterrupted = resolve;
      });
      setInterruptedSpy.mockImplementation(() => gate);
      handler = createHandler();

      const pending = handler.handleInterrupt();
      expect(handler.isInterruptRequested()).toBe(true);

      releaseInterrupted();
      await pending;
      expect(handler.isInterruptRequested()).toBe(false);
      expect(handler.getInterruptPromise()).toBeNull();
    });

    it('clears the requested flag on the idle early-return path', async () => {
      getStateSpy.mockReturnValue({ status: 'idle' });
      handler = createHandler();

      await handler.handleInterrupt();

      expect(handler.isInterruptRequested()).toBe(false);
    });

    it('should note the user interrupt before the idle early-return', async () => {
      getStateSpy.mockReturnValue({ status: 'idle', phase: 'idle' });
      handler = createHandler();

      await handler.handleInterrupt({ preserveDeliveryJobs: true });

      expect(queueNoteUserInterruptSpy).toHaveBeenCalledTimes(1);
      expect(setInterruptedSpy).not.toHaveBeenCalled();
    });

    it('clears the requested flag when delivery cancellation throws', async () => {
      cancelForSessionSpy.mockImplementation(() => {
        throw new Error('job queue unavailable');
      });
      handler = createHandler();

      await expect(handler.handleInterrupt()).rejects.toThrow('job queue unavailable');

      expect(handler.isInterruptRequested()).toBe(false);
      expect(handler.getInterruptPromise()).toBeNull();
    });

    it('keeps the requested flag while an overlapping interrupt is still running', async () => {
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      setInterruptedSpy.mockImplementation(() => gate);
      handler = createHandler();

      const first = handler.handleInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(setInterruptedSpy).toHaveBeenCalled();
      expect(handler.isInterruptRequested()).toBe(true);

      cancelForSessionSpy.mockImplementation(() => {
        throw new Error('job queue unavailable');
      });
      await expect(handler.handleInterrupt()).rejects.toThrow('job queue unavailable');
      expect(handler.isInterruptRequested()).toBe(true);

      releaseFirst();
      await first;
      expect(handler.isInterruptRequested()).toBe(false);
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

    it('should publish a failed status change for terminalized enqueued deliveries', async () => {
      cancelForSessionSpy.mockImplementation(() => ['uuid-a', 'uuid-b']);
      markFailedSpy.mockImplementation((_sessionId: string, uuid: string) => `db-${uuid}`);
      handler = createHandler();

      await handler.handleInterrupt();

      expect(busPublishSpy).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-uuid-a', 'db-uuid-b'],
        status: 'failed',
      });
    });

    it('should not publish a failed status change when nothing terminalized', async () => {
      handler = createHandler();

      await handler.handleInterrupt();

      expect(busPublishSpy).not.toHaveBeenCalledWith('messages.statusChanged', expect.anything());
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
      expect(callOrder).toEqual(['cancel', 'setInterrupted']);
    });

    it('notifies the delivery feeds (sdk_messages + job_queue) after cancelling deliveries (#862 review P1)', async () => {
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

      expect(cancelForSessionSpy).toHaveBeenCalledWith('test-session-id');
      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'pre-claim-uuid');
    });

    it('terminalizes enqueued orphan rows (no active job) so a Stop is not undone by the post-interrupt idle reconcile (#861)', async () => {
      cancelForSessionSpy = mock(() => ['active-uuid']);
      const orphan = { uuid: 'orphan-uuid' };
      const getUserMessageIdsByStatusSpy = mock((_sid: string, status: string) =>
        status === 'enqueued' ? [orphan] : []
      );
      mockDb = {
        getJobQueueRepo: mock(() => ({ cancelForSessionWithMessages: cancelForSessionSpy })),
        getSDKMessageRepo: mock(() => ({ markDeliveryFailedByUuid: markFailedSpy })),
        getUserMessageIdsByStatus: getUserMessageIdsByStatusSpy,
      } as unknown as InterruptHandlerContext['db'];
      handler = createHandler({ db: mockDb });

      await handler.handleInterrupt();

      expect(markFailedSpy).toHaveBeenCalledWith('test-session-id', 'active-uuid');
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

    describe('interrupt receipt survivors (cancel_async_message)', () => {
      it('cancels queued survivors via cancel_async_message when interrupt_cancel_queued_v1 is advertised', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a', 'uuid-b'] }));
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler();

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).toHaveBeenCalledTimes(2);
        expect(sdkCancelAsyncMessageSpy).toHaveBeenCalledWith('uuid-a');
        expect(sdkCancelAsyncMessageSpy).toHaveBeenCalledWith('uuid-b');
        expect(mockLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('closing immediately'),
          expect.anything()
        );
      });

      it('falls back to closing immediately when the capability is absent', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
        handler = createHandler();

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('closing immediately')
        );
        expect(sdkCloseSpy).toHaveBeenCalled();
      });

      it('falls back to closing when cancel_async_message does not confirm the cancellation', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({
          still_queued: ['uuid-a', 'uuid-b'],
        }));
        sdkCancelAsyncMessageSpy.mockImplementation(async (uuid: string) => uuid !== 'uuid-a');
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler();

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).toHaveBeenCalledTimes(1);
        expect(sdkCancelAsyncMessageSpy).toHaveBeenCalledWith('uuid-a');
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('did not confirm cancellation of uuid-a')
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('closing immediately')
        );
        expect(sdkCloseSpy).toHaveBeenCalled();
      });

      it('falls back to closing immediately when cancel_async_message fails', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
        sdkCancelAsyncMessageSpy.mockRejectedValue(new Error('Cancel rejected'));
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler();

        await handler.handleInterrupt();

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('cancel_async_message failed (Cancel rejected)')
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('closing immediately')
        );
        expect(sdkCloseSpy).toHaveBeenCalled();
      });

      it('falls back to closing immediately when the query object lacks cancelAsyncMessage', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler({
          queryObject: { interrupt: sdkInterruptSpy, close: sdkCloseSpy } as unknown as Query,
        });

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('closing immediately')
        );
        expect(sdkCloseSpy).toHaveBeenCalled();
      });

      it('sends no cancel_async_message when the receipt has no survivors', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: [] }));
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler();

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).not.toHaveBeenCalled();
        expect(sdkCloseSpy).toHaveBeenCalled();
      });

      it('delays the query abort until survivor cancellation has settled', async () => {
        const abortController = new AbortController();
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
        const abortStatesDuringCancel: boolean[] = [];
        sdkCancelAsyncMessageSpy.mockImplementation(async () => {
          abortStatesDuringCancel.push(abortController.signal.aborted);
          return true;
        });
        getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
        handler = createHandler({ queryAbortController: abortController });

        await handler.handleInterrupt();

        expect(abortStatesDuringCancel).toEqual([false]);
        expect(abortController.signal.aborted).toBe(true);
      });

      it('falls back to closing when a survivor cancellation never settles', async () => {
        process.env.HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS = '20';
        try {
          sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
          sdkCancelAsyncMessageSpy.mockImplementation(() => new Promise<boolean>(() => {}));
          getSdkCapabilitiesSpy.mockImplementation(() => new Set(['interrupt_cancel_queued_v1']));
          handler = createHandler();

          await handler.handleInterrupt();

          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('cancel_async_message did not settle within 20ms')
          );
          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('closing immediately')
          );
          expect(sdkCloseSpy).toHaveBeenCalled();
        } finally {
          delete process.env.HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS;
        }
      });

      it('falls back to closing when interrupt() never answers', async () => {
        process.env.HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS = '20';
        try {
          sdkInterruptSpy.mockImplementation(() => new Promise(() => {}));
          handler = createHandler();

          await handler.handleInterrupt();

          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('interrupt() did not answer within 20ms')
          );
          expect(sdkCloseSpy).toHaveBeenCalled();
        } finally {
          delete process.env.HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS;
        }
      });

      it('falls back to closing immediately when no capability provider is wired', async () => {
        sdkInterruptSpy.mockImplementation(async () => ({ still_queued: ['uuid-a'] }));
        handler = createHandler({ getSdkCapabilities: undefined });

        await handler.handleInterrupt();

        expect(sdkCancelAsyncMessageSpy).not.toHaveBeenCalled();
        expect(sdkCloseSpy).toHaveBeenCalled();
      });
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
      handler = createHandler();

      await handler.handleInterrupt();
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
      handler = createHandler();

      await handler.handleInterrupt({ skipDeferredReplay: true });

      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('should honor teardown suppression in the delayed replay path', async () => {
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
      let settleOldQuery!: () => void;
      const queryPromise = new Promise<void>((resolve) => {
        settleOldQuery = resolve;
      });
      handler = createHandler({ queryPromise });

      const interrupted = handler.handleInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();

      settleOldQuery();
      await interrupted;
      getStateSpy.mockReturnValue({ status: 'idle' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).toHaveBeenCalledWith('query.trigger', {
        sessionId: 'test-session-id',
      });
    });

    it('lets a later teardown request suppress an in-flight interrupt replay', async () => {
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

      const interrupted = handler.handleInterrupt();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await handler.handleInterrupt({ skipDeferredReplay: true });

      settleOldQuery();
      await interrupted;
      status = 'idle';
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('skips the delayed replay when a newer turn started before the process exited', async () => {
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      let status = 'processing';
      getStateSpy.mockImplementation(() => ({ status }));
      handler = createHandler({ processExitedPromise });

      await handler.handleInterrupt();
      status = 'idle';
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = 'processing';
      signalProcessExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('skips the delayed replay when a replacement query advanced the generation', async () => {
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      let queryGeneration = 7;
      handler = createHandler({
        processExitedPromise,
        getQueryGeneration: () => queryGeneration,
      });

      await handler.handleInterrupt();
      queryGeneration = 8;
      signalProcessExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).not.toHaveBeenCalled();
    });

    it('still replays after the process exits when the generation is unchanged', async () => {
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      handler = createHandler({
        processExitedPromise,
        getQueryGeneration: () => 7,
      });

      await handler.handleInterrupt();
      getStateSpy.mockReturnValue({ status: 'idle' });
      signalProcessExit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(busPublishAsyncSpy).toHaveBeenCalledWith('query.trigger', {
        sessionId: 'test-session-id',
      });
    });

    it('should delay query.trigger until the subprocess exits even when the query settled in time', async () => {
      let signalProcessExit!: () => void;
      const processExitedPromise = new Promise<void>((resolve) => {
        signalProcessExit = resolve;
      });
      handler = createHandler({ processExitedPromise });

      await handler.handleInterrupt();
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

      const interruptComplete = handler.handleInterrupt();
      await interruptComplete;

      expect(handler.getInterruptPromise()).toBeNull();
    });

    it('should handle query object without interrupt method', async () => {
      handler = createHandler({ queryObject: {} as Query });

      await handler.handleInterrupt();

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

      await handler.handleInterrupt();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SDK close() failed'),
        'Close failed'
      );
    });

    it('should skip close() when queryObject is null', async () => {
      handler = createHandler({ queryObject: null });

      await handler.handleInterrupt();

      expect(sdkCloseSpy).not.toHaveBeenCalled();
    });
  });

  describe('pre-acknowledgment interrupt against a real queue and real delivery rows', () => {
    interface RealFixture {
      db: Awaited<ReturnType<typeof createTestDb>>;
      queue: MessageQueue;
      handler: InterruptHandler;
      published: Array<{ channel: string; payload: Record<string, unknown> }>;
      sendStatusOf: (uuid: string) => string | null | undefined;
    }

    async function makeRealFixture(sessionId: string): Promise<RealFixture> {
      const db = await createTestDb();
      const session = createTestSession(sessionId);
      db.createSession(session);
      const queue = new MessageQueue();
      const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
      const bus = {
        publish: mock(async (channel: string, payload: Record<string, unknown>) => {
          published.push({ channel, payload });
        }),
        publishAsync: mock(async () => {}),
      };
      const handler = new InterruptHandler({
        session,
        messageHub: mockMessageHub,
        messageQueue: queue,
        stateManager: mockStateManager,
        logger: mockLogger,
        db,
        internalEventBus: bus as unknown as InterruptHandlerContext['internalEventBus'],
        queryObject: null,
        queryPromise: null,
        queryAbortController: new AbortController(),
        processExitedPromise: null,
      });
      const sendStatusOf = (uuid: string): string | null | undefined =>
        (
          db
            .getDatabase()
            .prepare(
              `SELECT send_status AS s FROM sdk_messages WHERE sdk_uuid = ? AND session_id = ?`
            )
            .get(uuid, sessionId) as { s: string | null } | undefined
        )?.s;
      return { db, queue, handler, published, sendStatusOf };
    }

    it('rejects pending entries and settles yielded in-flight entries when the interrupt clears the queue', async () => {
      const f = await makeRealFixture('sess-int-queue');
      try {
        f.queue.start();
        const inFlight = f.queue.enqueueWithId('int-first', 'in flight', false, { durable: true });
        const stillQueued = f.queue.enqueueWithId('int-second', 'still queued');
        const queuedOutcome = stillQueued.then(
          () => 'resolved',
          (error: Error) => error.message
        );
        const transport = f.queue.messageGenerator('sess-int-queue');
        const step = await transport.next();
        expect(step.value.message.uuid).toBe('int-first');

        await f.handler.handleInterrupt();

        await expect(inFlight).resolves.toBeUndefined();
        expect(await queuedOutcome).toBe('Interrupted by user');
        expect(f.queue.size()).toBe(0);
      } finally {
        f.db.close();
      }
    });

    it('fails only enqueued, deferred, and submitted delivery rows and never downgrades a consumed row', async () => {
      const f = await makeRealFixture('sess-int-routing');
      try {
        const sdkRepo = f.db.getSDKMessageRepo();
        const jobRepo = f.db.getJobQueueRepo();
        const cases: Array<[string, 'enqueued' | 'deferred' | 'submitted' | 'consumed']> = [
          ['msg-int-enqueued', 'enqueued'],
          ['msg-int-deferred', 'deferred'],
          ['msg-int-submitted', 'submitted'],
          ['msg-int-consumed', 'consumed'],
        ];
        for (const [uuid, sendStatus] of cases) {
          sdkRepo.saveUserMessage(
            'sess-int-routing',
            {
              type: 'user',
              uuid,
              message: { role: 'user', content: `text ${uuid}` },
            } as unknown as SDKMessage,
            sendStatus
          );
        }
        jobRepo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: {
            sessionId: 'sess-int-routing',
            messageUuid: 'msg-int-enqueued',
            role: 'turn',
            origin: 'chat',
            parentToolUseId: null,
            batchUuids: cases.map(([uuid]) => uuid),
          },
          maxRetries: MESSAGE_DELIVERY_MAX_RETRIES,
        });

        await f.handler.handleInterrupt();

        expect(f.sendStatusOf('msg-int-enqueued')).toBe('failed');
        expect(f.sendStatusOf('msg-int-deferred')).toBe('failed');
        expect(f.sendStatusOf('msg-int-submitted')).toBe('failed');
        expect(f.sendStatusOf('msg-int-consumed')).toBe('consumed');
        const statusEvents = f.published.filter(
          (event) => event.channel === 'messages.statusChanged'
        );
        expect(statusEvents).toHaveLength(1);
        expect((statusEvents[0].payload as { messageIds: string[] }).messageIds).toHaveLength(3);
        expect((statusEvents[0].payload as { status: string }).status).toBe('failed');
      } finally {
        f.db.close();
      }
    });
  });
});
