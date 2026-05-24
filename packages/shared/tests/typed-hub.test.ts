/**
 * TypedHub Unit Tests
 *
 * Tests for type-safe MessageHub wrapper with InProcessTransportBus.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TypedHub, TypedHubPublishError } from '../src/message-hub/typed-hub.ts';
import type { BaseEventData } from '../src/message-hub/typed-hub.ts';

// Define test event map (using dots like MessageHub convention)
interface TestEventMap extends Record<string, BaseEventData> {
  'session.created': { sessionId: string; title: string };
  'session.updated': { sessionId: string; title?: string; status?: string };
  'session.deleted': { sessionId: string };
  'message.sent': { sessionId: string; content: string };
  'context.updated': { sessionId: string; tokens: number };
}

describe('TypedHub', () => {
  let hub: TypedHub<TestEventMap>;

  beforeEach(async () => {
    hub = new TypedHub<TestEventMap>({ name: 'test-hub' });
    await hub.initialize();
  });

  afterEach(async () => {
    await hub.close();
  });

  describe('basic pub/sub', () => {
    it('should publish and receive events', async () => {
      const received: TestEventMap['session.created'][] = [];

      hub.subscribe('session.created', (data) => {
        received.push(data);
      });

      await hub.publish('session.created', {
        sessionId: 'test-1',
        title: 'Test Session',
      });

      expect(received.length).toBe(1);
      expect(received[0].sessionId).toBe('test-1');
      expect(received[0].title).toBe('Test Session');
    });

    it('should support multiple subscribers', async () => {
      const received1: string[] = [];
      const received2: string[] = [];

      hub.subscribe('session.created', (data) => {
        received1.push(data.sessionId);
      });

      hub.subscribe('session.created', (data) => {
        received2.push(data.sessionId);
      });

      await hub.publish('session.created', {
        sessionId: 'multi-test',
        title: 'Multi',
      });

      expect(received1).toEqual(['multi-test']);
      expect(received2).toEqual(['multi-test']);
    });

    it('should support unsubscribe', async () => {
      const received: string[] = [];

      const unsubscribe = hub.subscribe('session.created', (data) => {
        received.push(data.sessionId);
      });

      await hub.publish('session.created', {
        sessionId: 'before',
        title: 'Before',
      });

      unsubscribe();

      await hub.publish('session.created', {
        sessionId: 'after',
        title: 'After',
      });

      expect(received).toEqual(['before']);
    });

    it('should support once() for one-time subscriptions', async () => {
      const received: string[] = [];

      hub.once('session.created', (data) => {
        received.push(data.sessionId);
      });

      await hub.publish('session.created', {
        sessionId: 'first',
        title: 'First',
      });
      await hub.publish('session.created', {
        sessionId: 'second',
        title: 'Second',
      });

      // Should only receive first event
      expect(received).toEqual(['first']);
    });
  });

  describe('session-scoped subscriptions', () => {
    it('should filter events by sessionId', async () => {
      const session1Events: string[] = [];
      const session2Events: string[] = [];
      const allEvents: string[] = [];

      // Session-specific subscriptions
      hub.subscribe(
        'message.sent',
        (data) => {
          session1Events.push(data.content);
        },
        { sessionId: 'session-1' }
      );

      hub.subscribe(
        'message.sent',
        (data) => {
          session2Events.push(data.content);
        },
        { sessionId: 'session-2' }
      );

      // Global subscription (no sessionId filter)
      hub.subscribe('message.sent', (data) => {
        allEvents.push(data.content);
      });

      // Publish events for different sessions
      await hub.publish('message.sent', {
        sessionId: 'session-1',
        content: 'msg1',
      });
      await hub.publish('message.sent', {
        sessionId: 'session-2',
        content: 'msg2',
      });
      await hub.publish('message.sent', {
        sessionId: 'session-3',
        content: 'msg3',
      });

      // Session-specific handlers only get their session's events
      expect(session1Events).toEqual(['msg1']);
      expect(session2Events).toEqual(['msg2']);

      // Global handler gets all events
      expect(allEvents).toEqual(['msg1', 'msg2', 'msg3']);
    });

    it('should support session-scoped once()', async () => {
      const received: string[] = [];

      hub.once(
        'message.sent',
        (data) => {
          received.push(data.content);
        },
        { sessionId: 'target-session' }
      );

      // These should be filtered out
      await hub.publish('message.sent', {
        sessionId: 'other-session',
        content: 'other1',
      });
      await hub.publish('message.sent', {
        sessionId: 'other-session',
        content: 'other2',
      });

      // This should be received (and unsubscribe)
      await hub.publish('message.sent', {
        sessionId: 'target-session',
        content: 'target1',
      });

      // This should be missed (already unsubscribed)
      await hub.publish('message.sent', {
        sessionId: 'target-session',
        content: 'target2',
      });

      expect(received).toEqual(['target1']);
    });
  });

  describe('multi-participant communication', () => {
    it('should create participants connected to same bus', async () => {
      // Create participant connected to same bus
      const participant = hub.createParticipant('component-a');
      await participant.initialize();

      // Verify both share the same bus
      expect(participant.getBus()).toBe(hub.getBus());

      // Each participant receives its own locally published events
      const hubReceived: string[] = [];
      const participantReceived: string[] = [];

      hub.subscribe('session.created', (data) => {
        hubReceived.push('hub:' + data.sessionId);
      });

      participant.subscribe('session.created', (data) => {
        participantReceived.push('participant:' + data.sessionId);
      });

      // Hub publishes - hub receives via local dispatch
      await hub.publish('session.created', {
        sessionId: 'from-hub',
        title: 'From Hub',
      });

      // Participant publishes - participant receives via local dispatch
      await participant.publish('session.created', {
        sessionId: 'from-participant',
        title: 'From Participant',
      });

      // Local dispatch ensures each hub receives its own events
      expect(hubReceived).toContain('hub:from-hub');
      expect(participantReceived).toContain('participant:from-participant');

      // Note: Cross-hub delivery via MessageHub/bus is a future enhancement
      // For now, local dispatch provides EventBus-like behavior within each hub

      await participant.close();
    });
  });

  describe('async delivery semantics', () => {
    it('should await async handlers before publish returns', async () => {
      let handlerCompleted = false;

      hub.subscribe('session.created', async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        handlerCompleted = true;
      });

      expect(handlerCompleted).toBe(false);
      await hub.publish('session.created', {
        sessionId: 'async-test',
        title: 'Async',
      });
      expect(handlerCompleted).toBe(true);
    });

    it('should run multiple async handlers concurrently', async () => {
      const order: string[] = [];

      hub.subscribe('session.created', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('handler1');
      });

      hub.subscribe('session.created', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('handler2');
      });

      await hub.publish('session.created', {
        sessionId: 'concurrent-test',
        title: 'Concurrent',
      });

      // Both should have completed; handler2 finishes first due to shorter timeout
      expect(order).toEqual(['handler2', 'handler1']);
    });

    it('should return PublishResult with delivered count', async () => {
      hub.subscribe('session.created', () => {});
      hub.subscribe('session.created', () => {});

      const result = await hub.publish('session.created', {
        sessionId: 'count-test',
        title: 'Count',
      });

      expect(result.delivered).toBe(2);
      expect(result.failures).toEqual([]);
    });

    it('should return empty result when no handlers are registered', async () => {
      const result = await hub.publish('session.created', {
        sessionId: 'no-handlers',
        title: 'No Handlers',
      });

      expect(result.delivered).toBe(0);
      expect(result.failures).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('should throw when publishing before initialization', async () => {
      const uninitializedHub = new TypedHub<TestEventMap>({
        name: 'uninitialized',
      });

      await expect(
        uninitializedHub.publish('session.created', {
          sessionId: 'test',
          title: 'Test',
        })
      ).rejects.toThrow('not initialized');

      await uninitializedHub.close();
    });

    it('should surface sync handler errors in TypedHubPublishError', async () => {
      hub.subscribe('session.created', () => {
        throw new Error('sync boom');
      });

      try {
        await hub.publish('session.created', {
          sessionId: 'error-test',
          title: 'Error',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TypedHubPublishError);
        const typedErr = err as TypedHubPublishError;
        expect(typedErr.event).toBe('session.created');
        expect(typedErr.result.delivered).toBe(0);
        expect(typedErr.result.failures.length).toBe(1);
        expect(typedErr.result.failures[0].error.message).toBe('sync boom');
        expect(typedErr.result.failures[0].event).toBe('session.created');
      }
    });

    it('should surface async handler rejections in TypedHubPublishError', async () => {
      hub.subscribe('session.created', async () => {
        throw new Error('async boom');
      });

      try {
        await hub.publish('session.created', {
          sessionId: 'error-test',
          title: 'Error',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TypedHubPublishError);
        const typedErr = err as TypedHubPublishError;
        expect(typedErr.result.failures[0].error.message).toBe('async boom');
      }
    });

    it('should still run all handlers when one fails', async () => {
      const received: string[] = [];

      hub.subscribe('session.created', () => {
        throw new Error('first fails');
      });

      hub.subscribe('session.created', (data) => {
        received.push(data.sessionId);
      });

      hub.subscribe('session.created', async () => {
        throw new Error('third fails');
      });

      try {
        await hub.publish('session.created', {
          sessionId: 'partial-test',
          title: 'Partial',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TypedHubPublishError);
        const typedErr = err as TypedHubPublishError;
        expect(typedErr.result.delivered).toBe(1);
        expect(typedErr.result.failures.length).toBe(2);
        expect(received).toEqual(['partial-test']);
      }
    });

    it('should handle mixed sync and async handler failures', async () => {
      const received: string[] = [];

      hub.subscribe('session.created', () => {
        throw new Error('sync fail');
      });

      hub.subscribe('session.created', async (data) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        received.push(data.sessionId);
      });

      hub.subscribe('session.created', async () => {
        throw new Error('async fail');
      });

      try {
        await hub.publish('session.created', {
          sessionId: 'mixed-test',
          title: 'Mixed',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TypedHubPublishError);
        const typedErr = err as TypedHubPublishError;
        expect(typedErr.result.delivered).toBe(1);
        expect(typedErr.result.failures.length).toBe(2);
        expect(received).toEqual(['mixed-test']);
      }
    });

    it('should handle non-Error throws by wrapping them', async () => {
      hub.subscribe('session.created', () => {
        throw 'string error';
      });

      try {
        await hub.publish('session.created', {
          sessionId: 'string-error',
          title: 'String Error',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TypedHubPublishError);
        const typedErr = err as TypedHubPublishError;
        expect(typedErr.result.failures[0].error.message).toBe('string error');
      }
    });
  });

  describe('publishAsync', () => {
    it('should return immediately without waiting for handlers', async () => {
      let handlerCompleted = false;

      hub.subscribe('session.created', async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        handlerCompleted = true;
      });

      hub.publishAsync('session.created', {
        sessionId: 'async-test',
        title: 'Async',
      });

      // publishAsync returns immediately; handler has not completed
      expect(handlerCompleted).toBe(false);

      // Wait for the microtask to run
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(handlerCompleted).toBe(true);
    });

    it('should swallow handler errors silently', async () => {
      hub.subscribe('session.created', () => {
        throw new Error('should be swallowed');
      });

      // publishAsync should not throw even though handler throws
      expect(() => {
        hub.publishAsync('session.created', {
          sessionId: 'swallow-test',
          title: 'Swallow',
        });
      }).not.toThrow();

      // Wait for microtask
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('should throw when publishAsync called before initialization', async () => {
      const uninitializedHub = new TypedHub<TestEventMap>({
        name: 'uninitialized',
      });

      expect(() => {
        uninitializedHub.publishAsync('session.created', {
          sessionId: 'test',
          title: 'Test',
        });
      }).toThrow('not initialized');

      await uninitializedHub.close();
    });
  });

  describe('emit alias', () => {
    it('should behave identically to publish', async () => {
      const received: string[] = [];

      hub.subscribe('session.created', (data) => {
        received.push(data.sessionId);
      });

      const result = await hub.emit('session.created', {
        sessionId: 'emit-test',
        title: 'Emit',
      });

      expect(received).toEqual(['emit-test']);
      expect(result.delivered).toBe(1);
      expect(result.failures).toEqual([]);
    });
  });

  describe('multiple event types', () => {
    it('should handle multiple event types independently', async () => {
      const created: string[] = [];
      const deleted: string[] = [];

      hub.subscribe('session.created', (data) => {
        created.push(data.sessionId);
      });

      hub.subscribe('session.deleted', (data) => {
        deleted.push(data.sessionId);
      });

      await hub.publish('session.created', { sessionId: 'new', title: 'New' });
      await hub.publish('session.deleted', { sessionId: 'old' });
      await hub.publish('session.created', {
        sessionId: 'another',
        title: 'Another',
      });

      expect(created).toEqual(['new', 'another']);
      expect(deleted).toEqual(['old']);
    });
  });

  describe('underlying MessageHub access', () => {
    it('should provide access to underlying MessageHub', () => {
      const messageHub = hub.getMessageHub();
      expect(messageHub).toBeDefined();
      // Can use MessageHub for RPC if needed
      expect(typeof messageHub.request).toBe('function');
      expect(typeof messageHub.onRequest).toBe('function');
      expect(typeof messageHub.event).toBe('function');
      expect(typeof messageHub.onEvent).toBe('function');
    });

    it('should provide access to underlying bus', () => {
      const bus = hub.getBus();
      expect(bus).toBeDefined();
      expect(typeof bus.createTransport).toBe('function');
    });
  });

  describe('cleanup', () => {
    it('should cleanup subscriptions on close', async () => {
      const received: string[] = [];

      hub.subscribe('session.created', (data) => {
        received.push(data.sessionId);
      });

      await hub.publish('session.created', {
        sessionId: 'before-close',
        title: 'Before',
      });

      await hub.close();

      // After close, hub should be unusable
      await expect(
        hub.publish('session.created', {
          sessionId: 'after-close',
          title: 'After',
        })
      ).rejects.toThrow();

      // Only the first event should have been received
      expect(received).toEqual(['before-close']);
    });
  });
});
