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
      queryObject: mockQueryObject,
      queryPromise: mockQueryPromise,
      queryAbortController: mockAbortController,
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
