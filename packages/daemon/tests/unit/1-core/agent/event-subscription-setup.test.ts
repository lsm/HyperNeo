/**
 * EventSubscriptionSetup Tests
 *
 * Tests for DaemonHub event subscription setup.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  EventSubscriptionSetup,
  type EventSubscriptionSetupContext,
} from '../../../../src/lib/agent/event-subscription-setup';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Session } from '@neokai/shared';
import type { ModelSwitchHandler } from '../../../../src/lib/agent/model-switch-handler';
import type { InterruptHandler } from '../../../../src/lib/agent/interrupt-handler';
import type { QueryModeHandler } from '../../../../src/lib/agent/query-mode-handler';

describe('EventSubscriptionSetup', () => {
  let setup: EventSubscriptionSetup;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockContext: EventSubscriptionSetupContext;

  let onSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let unsubscribeSpy: ReturnType<typeof mock>;

  // Mock handlers
  let mockModelSwitchHandler: ModelSwitchHandler;
  let mockInterruptHandler: InterruptHandler;
  let mockQueryModeHandler: QueryModeHandler;

  // Store callbacks registered via daemonHub.on()
  let registeredCallbacks: Map<string, (data: unknown) => Promise<void>>;

  beforeEach(() => {
    registeredCallbacks = new Map();
    unsubscribeSpy = mock(() => {});

    // Mock subscriptions to capture callbacks and return unsubscribe function
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

    // Create mock handlers
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

    // Create mock session
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

    // Create context
    mockContext = {
      session: mockSession,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      modelSwitchHandler: mockModelSwitchHandler,
      interruptHandler: mockInterruptHandler,
      queryModeHandler: mockQueryModeHandler,
      resetQuery: mock(async () => ({ success: true })),
      startQueryAndEnqueue: mock(async () => {}),
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

      // Should register 6 event handlers
      expect(onSpy).toHaveBeenCalledTimes(6);
      expect(registeredCallbacks.has('model.switchRequest')).toBe(true);
      expect(registeredCallbacks.has('agent.interruptRequest')).toBe(true);
      expect(registeredCallbacks.has('agent.resetRequest')).toBe(true);
      expect(registeredCallbacks.has('message.persisted')).toBe(true);
      expect(registeredCallbacks.has('query.trigger')).toBe(true);
      expect(registeredCallbacks.has('query.sendEnqueuedOnTurnEnd')).toBe(true);
    });

    it('should pass sessionId to subscription options', () => {
      setup.setup();

      // All subscriptions should include sessionId option
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
      it('should call startQueryAndEnqueue with messageId and content', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('message.persisted')!;
        await callback({
          sessionId: 'test-session-id',
          messageId: 'msg-123',
          messageContent: 'Hello',
        });

        // Note: User messages in the DB serve as rewind points - no separate checkpoint tracking needed
        expect(mockContext.startQueryAndEnqueue).toHaveBeenCalledWith('msg-123', 'Hello');
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
      });
    });

    describe('query.trigger handler', () => {
      it('should call queryModeHandler.handleQueryTrigger', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('query.trigger')!;
        await callback({ sessionId: 'test-session-id' });

        expect(mockQueryModeHandler.handleQueryTrigger).toHaveBeenCalled();
      });
    });

    describe('query.sendEnqueuedOnTurnEnd handler', () => {
      it('should call queryModeHandler.sendEnqueuedMessagesOnTurnEnd', async () => {
        setup.setup();

        const callback = registeredCallbacks.get('query.sendEnqueuedOnTurnEnd')!;
        await callback({ sessionId: 'test-session-id' });

        expect(mockQueryModeHandler.sendEnqueuedMessagesOnTurnEnd).toHaveBeenCalled();
      });
    });
  });

  describe('cleanup', () => {
    it('should call all unsubscribe functions', () => {
      setup.setup();
      setup.cleanup();

      // 6 subscriptions = 6 unsubscribe calls
      expect(unsubscribeSpy).toHaveBeenCalledTimes(6);
    });

    it('should clear unsubscribers array', () => {
      setup.setup();
      setup.cleanup();

      // Second cleanup should not call unsubscribe again
      setup.cleanup();
      expect(unsubscribeSpy).toHaveBeenCalledTimes(6); // Still 6, not 12
    });

    it('should handle unsubscribe errors gracefully', () => {
      // Make unsubscribe throw
      unsubscribeSpy.mockImplementation(() => {
        throw new Error('Unsubscribe failed');
      });

      setup.setup();

      // Should not throw
      setup.cleanup();
    });

    it('should work when called before setup', () => {
      // Should not throw
      setup.cleanup();
      expect(unsubscribeSpy).not.toHaveBeenCalled();
    });
  });
});
