import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  EventSubscriptionSetup,
  type EventSubscriptionSetupContext,
} from '../../../../src/lib/agent/event-subscription-setup';
import { InterruptHandler } from '../../../../src/lib/agent/interrupt-handler';
import { deliverMessage } from '../../../../src/lib/agent/message-delivery';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createTables } from '../../../../src/storage/schema/index';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Session } from '@hyperneo/shared';
import type { ModelSwitchHandler } from '../../../../src/lib/agent/model-switch-handler';
import type { QueryModeHandler } from '../../../../src/lib/agent/query-mode-handler';

describe('EventSubscriptionSetup', () => {
  let setup: EventSubscriptionSetup;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockContext: EventSubscriptionSetupContext;

  let onSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let unsubscribeSpy: ReturnType<typeof mock>;

  let mockModelSwitchHandler: ModelSwitchHandler;
  let mockInterruptHandler: InterruptHandler;
  let mockQueryModeHandler: QueryModeHandler;

  let registeredCallbacks: Map<string, (data: unknown) => Promise<void>>;

  beforeEach(() => {
    registeredCallbacks = new Map();
    unsubscribeSpy = mock(() => {});

    onSpy = mock((event: string, callback: (data: unknown) => Promise<void>) => {
      registeredCallbacks.set(event, callback);
      return unsubscribeSpy;
    });

    emitSpy = mock(async () => {});
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: onSpy,
    } as unknown as InternalEventBus<any>;

    mockDaemonHub = {
      on: onSpy,
      emit: emitSpy,
    } as unknown as DaemonHub;

    mockModelSwitchHandler = {
      switchModel: mock(async () => ({ success: true, model: 'test-model' })),
    } as unknown as ModelSwitchHandler;

    mockInterruptHandler = {
      handleInterrupt: mock(async () => {}),
    } as unknown as InterruptHandler;

    mockQueryModeHandler = {
      handleQueryTrigger: mock(async () => ({ success: true, messageCount: 1 })),
      sendEnqueuedMessagesOnTurnEnd: mock(async () => {}),
    } as unknown as QueryModeHandler;

    const mockSession: Session = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {},
    };

    mockContext = {
      session: mockSession,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      modelSwitchHandler: mockModelSwitchHandler,
      interruptHandler: mockInterruptHandler,
      queryModeHandler: mockQueryModeHandler,
      resetQuery: mock(async () => ({ success: true })),
      startQueryAndEnqueue: mock(async () => {}),
      deliverChatMessage: mock(async () => {}),
    };

    setup = new EventSubscriptionSetup(mockContext);
  });

  describe('constructor', () => {
    it('should create setup with dependencies', () => {
      expect(setup).toBeDefined();
    });
  });

  describe('setup', () => {
    it('should register all event subscriptions', () => {
      setup.setup();

      expect(onSpy).toHaveBeenCalledTimes(5);
      expect(registeredCallbacks.has('model.switchRequest')).toBe(true);
      expect(registeredCallbacks.has('agent.interruptRequest')).toBe(true);
      expect(registeredCallbacks.has('agent.resetRequest')).toBe(true);
      expect(registeredCallbacks.has('message.persisted')).toBe(true);
      expect(registeredCallbacks.has('query.trigger')).toBe(true);
    });

    it('should pass sessionId to subscription options', () => {
      setup.setup();

      for (const call of onSpy.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ sessionId: 'test-session-id' }));
      }
    });

    describe('model.switchRequest handler', () => {
      it('should call modelSwitchHandler.switchModel and emit result', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('model.switchRequest')!;
        await callback({ sessionId: 'test-session-id', model: 'opus', provider: 'anthropic' });

        expect(mockModelSwitchHandler.switchModel).toHaveBeenCalledWith('opus', 'anthropic');
        expect(emitSpy).toHaveBeenCalledWith('model.switched', {
          sessionId: 'test-session-id',
          success: true,
          model: 'test-model',
          error: undefined,
        });
      });

      it('should handle switch errors', async () => {
        (mockModelSwitchHandler.switchModel as ReturnType<typeof mock>).mockResolvedValue({
          success: false,
          model: 'opus',
          error: 'Invalid model',
        });

        setup.setup();

        const callback = registeredCallbacks.get('model.switchRequest')!;
        await callback({ sessionId: 'test-session-id', model: 'opus', provider: 'anthropic' });

        expect(emitSpy).toHaveBeenCalledWith('model.switched', {
          sessionId: 'test-session-id',
          success: false,
          model: 'opus',
          error: 'Invalid model',
        });
      });

      it('should throw when provider is missing from event', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('model.switchRequest')!;
        await expect(callback({ sessionId: 'test-session-id', model: 'opus' })).rejects.toThrow(
          'model.switchRequest event is missing required field: provider'
        );
      });
    });

    describe('agent.interruptRequest handler', () => {
      it('should call interruptHandler.handleInterrupt and emit interrupted', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('agent.interruptRequest')!;
        await callback({ sessionId: 'test-session-id' });

        expect(mockInterruptHandler.handleInterrupt).toHaveBeenCalled();
        expect(emitSpy).toHaveBeenCalledWith('agent.interrupted', {
          sessionId: 'test-session-id',
        });
      });

      it('client.interrupt RPC path cancels pending durable deliveries end-to-end (#3744105273)', async () => {
        const raw = new BunDatabase(':memory:');
        createTables(raw);
        const jobQueueRepo = new JobQueueRepository(raw);
        const sdkRepo = new SDKMessageRepository(raw);
        const sessionId = 'test-session-id';
        const messageUuid = '11111111-2222-3333-4444-555555555555';

        raw
          .prepare(
            `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
             VALUES (?, ?, 'user', ?, ?, 'enqueued', ?)`
          )
          .run(
            'db-msg-1',
            sessionId,
            JSON.stringify({ uuid: messageUuid }),
            new Date().toISOString(),
            messageUuid
          );
        deliverMessage(jobQueueRepo, sessionId, messageUuid, { origin: 'chat' });
        expect((raw.prepare(`SELECT COUNT(*) AS n FROM job_queue`).get() as { n: number }).n).toBe(
          1
        );

        const realInterruptHandler = new InterruptHandler({
          session: mockContext.session,
          messageHub: { event: () => {} } as never,
          messageQueue: { size: () => 0, clear: () => {}, stop: () => {} } as never,
          stateManager: {
            getState: () => ({ status: 'processing', phase: 'streaming' }),
            setInterrupted: async () => {},
            setIdle: async () => {},
          } as never,
          logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
          db: {
            getJobQueueRepo: () => jobQueueRepo,
            getSDKMessageRepo: () => sdkRepo,
          } as never,
          queryObject: null,
          queryPromise: null,
          queryAbortController: null,
          internalEventBus: mockInternalEventBus,
        });

        const rpcContext: EventSubscriptionSetupContext = {
          ...mockContext,
          interruptHandler: realInterruptHandler,
        };
        const rpcSetup = new EventSubscriptionSetup(rpcContext);
        rpcSetup.setup();

        const callback = registeredCallbacks.get('agent.interruptRequest')!;
        await callback({ sessionId });

        expect((raw.prepare(`SELECT COUNT(*) AS n FROM job_queue`).get() as { n: number }).n).toBe(
          0
        );
        const row = raw
          .prepare(`SELECT send_status AS sendStatus FROM sdk_messages WHERE id = 'db-msg-1'`)
          .get() as { sendStatus: string };
        expect(row.sendStatus).toBe('failed');
        raw.close();
      });

      it('handleInterrupt({preserveDeliveryJobs:true}) keeps requeued delivery jobs for restart (Codex P1)', async () => {
        const raw = new BunDatabase(':memory:');
        createTables(raw);
        const jobQueueRepo = new JobQueueRepository(raw);
        const sdkRepo = new SDKMessageRepository(raw);
        const sessionId = 'test-session-id';
        const messageUuid = '22222222-3333-4444-5555-666666666666';

        raw
          .prepare(
            `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
             VALUES (?, ?, 'user', ?, ?, 'enqueued', ?)`
          )
          .run(
            'db-msg-2',
            sessionId,
            JSON.stringify({ uuid: messageUuid }),
            new Date().toISOString(),
            messageUuid
          );
        deliverMessage(jobQueueRepo, sessionId, messageUuid, { origin: 'space_inject' });
        expect((raw.prepare(`SELECT COUNT(*) AS n FROM job_queue`).get() as { n: number }).n).toBe(
          1
        );

        const realInterruptHandler = new InterruptHandler({
          session: mockContext.session,
          messageHub: { event: () => {} } as never,
          messageQueue: { size: () => 0, clear: () => {}, stop: () => {} } as never,
          stateManager: {
            getState: () => ({ status: 'processing', phase: 'streaming' }),
            setInterrupted: async () => {},
            setIdle: async () => {},
          } as never,
          logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } as never,
          db: {
            getJobQueueRepo: () => jobQueueRepo,
            getSDKMessageRepo: () => sdkRepo,
          } as never,
          queryObject: null,
          queryPromise: null,
          queryAbortController: null,
          internalEventBus: mockInternalEventBus,
        });

        await realInterruptHandler.handleInterrupt({ preserveDeliveryJobs: true });

        expect((raw.prepare(`SELECT COUNT(*) AS n FROM job_queue`).get() as { n: number }).n).toBe(
          1
        );
        const row = raw
          .prepare(`SELECT send_status AS sendStatus FROM sdk_messages WHERE id = 'db-msg-2'`)
          .get() as { sendStatus: string };
        expect(row.sendStatus).toBe('enqueued');
        raw.close();
      });
    });

    describe('agent.resetRequest handler', () => {
      it('should call resetQuery with restartQuery flag', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('agent.resetRequest')!;
        await callback({ sessionId: 'test-session-id', restartQuery: false });

        expect(mockContext.resetQuery).toHaveBeenCalledWith({
          restartQuery: false,
          hardReset: true,
        });
        expect(emitSpy).toHaveBeenCalledWith('agent.reset', {
          sessionId: 'test-session-id',
          success: true,
          error: undefined,
        });
      });

      it('should default restartQuery to true if not provided', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('agent.resetRequest')!;
        await callback({ sessionId: 'test-session-id' });

        expect(mockContext.resetQuery).toHaveBeenCalledWith({
          restartQuery: true,
          hardReset: true,
        });
      });

      it('should handle reset errors', async () => {
        (mockContext.resetQuery as ReturnType<typeof mock>).mockResolvedValue({
          success: false,
          error: 'Reset failed',
        });

        setup.setup();

        const callback = registeredCallbacks.get('agent.resetRequest')!;
        await callback({ sessionId: 'test-session-id', restartQuery: true });

        expect(emitSpy).toHaveBeenCalledWith('agent.reset', {
          sessionId: 'test-session-id',
          success: false,
          error: 'Reset failed',
        });
      });
    });

    describe('message.persisted handler', () => {
      it('v2 default routes through deliverChatMessage, not startQueryAndEnqueue', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('message.persisted')!;
        await callback({
          sessionId: 'test-session-id',
          messageId: 'msg-123',
          messageContent: 'Hello',
        });

        expect(mockContext.deliverChatMessage).toHaveBeenCalledWith('msg-123');
        expect(mockContext.startQueryAndEnqueue).not.toHaveBeenCalled();
      });

      it('opt-out (HYPERNEO_MESSAGE_DELIVERY_V2=0) falls back to startQueryAndEnqueue', async () => {
        const previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
        process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
        try {
          setup.setup();

          const callback = registeredCallbacks.get('message.persisted')!;
          await callback({
            sessionId: 'test-session-id',
            messageId: 'msg-123',
            messageContent: 'Hello',
          });
        } finally {
          if (previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
          else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previous;
        }

        expect(mockContext.startQueryAndEnqueue).toHaveBeenCalledWith('msg-123', 'Hello');
        expect(mockContext.deliverChatMessage).not.toHaveBeenCalled();
      });

      it('should skip query start when persistence already delivered synchronously', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('message.persisted')!;
        await callback({
          sessionId: 'test-session-id',
          messageId: 'msg-123',
          messageContent: 'Hello',
          skipQueryStart: true,
        });

        expect(mockContext.startQueryAndEnqueue).not.toHaveBeenCalled();
        expect(mockContext.deliverChatMessage).not.toHaveBeenCalled();
      });
    });

    describe('query.trigger handler', () => {
      it('should call queryModeHandler.handleQueryTrigger', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('query.trigger')!;
        await callback({ sessionId: 'test-session-id' });

        expect(mockQueryModeHandler.handleQueryTrigger).toHaveBeenCalled();
      });

      it('does not block the turn-end publish while the replay is in flight', async () => {
        setup.setup();
        let releaseReplay!: () => void;
        const replayGate = new Promise<void>((resolve) => {
          releaseReplay = resolve;
        });
        (mockQueryModeHandler.handleQueryTrigger as ReturnType<typeof mock>).mockImplementation(
          async () => {
            await replayGate;
            return { success: true, messageCount: 1 };
          }
        );

        const callback = registeredCallbacks.get('query.trigger')!;
        const invoke = (async () => {
          await callback({ sessionId: 'test-session-id' });
        })();

        const settled = await Promise.race([
          invoke.then(() => 'resolved'),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
        ]);
        expect(settled).toBe('resolved');
        expect(mockQueryModeHandler.handleQueryTrigger).toHaveBeenCalled();

        releaseReplay();
        await invoke;
      });
    });
  });

  describe('cleanup', () => {
    it('should call all unsubscribe functions', () => {
      setup.setup();
      setup.cleanup();

      expect(unsubscribeSpy).toHaveBeenCalledTimes(5);
    });

    it('should clear unsubscribers array', () => {
      setup.setup();
      setup.cleanup();

      setup.cleanup();
      expect(unsubscribeSpy).toHaveBeenCalledTimes(5);
    });

    it('should handle unsubscribe errors gracefully', () => {
      unsubscribeSpy.mockImplementation(() => {
        throw new Error('Unsubscribe failed');
      });

      setup.setup();

      setup.cleanup();
    });

    it('should work when called before setup', () => {
      setup.cleanup();
      expect(unsubscribeSpy).not.toHaveBeenCalled();
    });
  });
});
