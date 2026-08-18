import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createInternalEventBus,
  createDaemonInternalEventBus,
  InternalEventBus,
  InternalEventBusPublishError,
} from '../../../../src/lib/internal-event-bus';

interface TestEventMap {
  'session.created': { namespaceId: string; title: string };
  'session.updated': { namespaceId: string; title?: string };
  'session.deleted': { namespaceId: string };
  'app.ping': { namespaceId: string; ts: number };
}

interface KeyedInterfaceEventMap {
  'order.placed': { namespaceId: string; orderId: string };
  'order.shipped': { namespaceId: string; orderId: string; tracking: string };
}

describe('InternalEventBus', () => {
  let bus: InternalEventBus<TestEventMap>;

  beforeEach(() => {
    bus = new InternalEventBus<TestEventMap>();
  });

  describe('subscribe', () => {
    it('should require a non-empty subscriberName', () => {
      expect(() => bus.subscribe('session.created', () => {}, { subscriberName: '' })).toThrow(
        'subscriberName'
      );

      expect(() => bus.subscribe('session.created', () => {}, { subscriberName: '   ' })).toThrow(
        'subscriberName'
      );
    });

    it('should reject the reserved global namespace key as an explicit namespaceId', () => {
      expect(() =>
        bus.subscribe('session.created', () => {}, {
          subscriberName: 'bad',
          namespaceId: '__global__',
        })
      ).toThrow('reserved');
    });

    it('should return an unsubscribe function', () => {
      const unsub = bus.subscribe('session.created', () => {}, {
        subscriberName: 'test-sub',
      });
      expect(typeof unsub).toBe('function');
    });

    it('should remove handler when unsubscribe is called', async () => {
      const received: string[] = [];
      const unsub = bus.subscribe(
        'session.created',
        (data) => {
          received.push(data.namespaceId);
        },
        { subscriberName: 'a' }
      );

      await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
      expect(received).toEqual(['s1']);

      unsub();
      await bus.publish('session.created', { namespaceId: 's2', title: 'T2' });
      expect(received).toEqual(['s1']);
    });
  });

  describe('publish – awaited handler behaviour', () => {
    it('should await a single handler', async () => {
      let received = false;
      bus.subscribe(
        'session.created',
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          received = true;
        },
        { subscriberName: 'single' }
      );

      const result = await bus.publish('session.created', {
        namespaceId: 's1',
        title: 'T1',
      });
      expect(received).toBe(true);
      expect(result.delivered).toBe(1);
      expect(result.failures).toHaveLength(0);
    });

    it('should await multiple handlers concurrently', async () => {
      const order: number[] = [];

      bus.subscribe(
        'session.created',
        async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push(1);
        },
        { subscriberName: 'slow' }
      );

      bus.subscribe(
        'session.created',
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push(2);
        },
        { subscriberName: 'fast' }
      );

      const result = await bus.publish('session.created', {
        namespaceId: 's1',
        title: 'T1',
      });

      expect(result.delivered).toBe(2);
      expect(order).toEqual([2, 1]);
    });

    it('should return empty result when no handlers are registered', async () => {
      const result = await bus.publish('session.deleted', { namespaceId: 'orphan' });
      expect(result.delivered).toBe(0);
      expect(result.failures).toHaveLength(0);
    });

    it('should deliver to both session-scoped and global handlers', async () => {
      const hits: string[] = [];

      bus.subscribe('session.created', () => hits.push('global'), { subscriberName: 'global' });
      bus.subscribe('session.created', () => hits.push('scoped'), {
        subscriberName: 'scoped',
        namespaceId: 's1',
      });
      bus.subscribe('session.created', () => hits.push('other-scope'), {
        subscriberName: 'other',
        namespaceId: 's2',
      });

      const result = await bus.publish('session.created', {
        namespaceId: 's1',
        title: 'T1',
      });

      expect(hits.sort()).toEqual(['global', 'scoped']);
      expect(result.delivered).toBe(2);
    });

    it('should not double-deliver when namespaceId equals the global sentinel', async () => {
      const hits: string[] = [];

      bus.subscribe('session.created', () => hits.push('global'), { subscriberName: 'global' });

      const result = await bus.publish('session.created', {
        namespaceId: '__global__',
        title: 'T1',
      });

      expect(hits).toEqual(['global']);
      expect(result.delivered).toBe(1);
    });
  });

  describe('publish – handler failure behaviour', () => {
    it('should throw InternalEventBusPublishError when a handler throws', async () => {
      const err = new Error('boom');
      bus.subscribe(
        'session.created',
        () => {
          throw err;
        },
        { subscriberName: 'flaky' }
      );

      try {
        await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(InternalEventBusPublishError);
        const pe = e as InternalEventBusPublishError;
        expect(pe.event).toBe('session.created');
        expect(pe.result.delivered).toBe(0);
        expect(pe.result.failures).toHaveLength(1);
        expect(pe.result.failures[0].subscriberName).toBe('flaky');
        expect(pe.result.failures[0].event).toBe('session.created');
        expect(pe.result.failures[0].error).toBe(err);
      }
    });

    it('should throw when a handler rejects', async () => {
      const err = new Error('async boom');
      bus.subscribe(
        'session.created',
        async () => {
          throw err;
        },
        { subscriberName: 'async-flaky' }
      );

      await expect(
        bus.publish('session.created', { namespaceId: 's1', title: 'T1' })
      ).rejects.toBeInstanceOf(InternalEventBusPublishError);
    });

    it('should still run remaining handlers when one throws', async () => {
      const hits: string[] = [];

      bus.subscribe(
        'session.created',
        () => {
          throw new Error('first');
        },
        { subscriberName: 'bad' }
      );

      bus.subscribe(
        'session.created',
        () => {
          hits.push('good');
        },
        { subscriberName: 'good' }
      );

      bus.subscribe(
        'session.created',
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          hits.push('async-good');
        },
        { subscriberName: 'async-good' }
      );

      try {
        await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
        expect.unreachable('should have thrown');
      } catch (e) {
        const pe = e as InternalEventBusPublishError;
        expect(pe.result.delivered).toBe(2);
        expect(pe.result.failures).toHaveLength(1);
        expect(hits.sort()).toEqual(['async-good', 'good']);
      }
    });

    it('should collect multiple failures in a single publish', async () => {
      bus.subscribe(
        'session.created',
        () => {
          throw new Error('a');
        },
        { subscriberName: 'a' }
      );
      bus.subscribe(
        'session.created',
        () => {
          throw new Error('b');
        },
        { subscriberName: 'b' }
      );

      try {
        await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
        expect.unreachable('should have thrown');
      } catch (e) {
        const pe = e as InternalEventBusPublishError;
        expect(pe.result.failures).toHaveLength(2);
        const names = pe.result.failures.map((f) => f.subscriberName).sort();
        expect(names).toEqual(['a', 'b']);
      }
    });

    it('should wrap non-Error throws in Error objects', async () => {
      bus.subscribe(
        'session.created',
        () => {
          throw 'string-throw';
        },
        { subscriberName: 'weird' }
      );

      try {
        await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
        expect.unreachable('should have thrown');
      } catch (e) {
        const pe = e as InternalEventBusPublishError;
        expect(pe.result.failures[0].error).toBeInstanceOf(Error);
        expect(pe.result.failures[0].error.message).toBe('string-throw');
      }
    });
  });

  describe('publishAsync – fire-and-forget', () => {
    it('should return immediately without awaiting handlers', async () => {
      let resolved = false;
      bus.subscribe(
        'session.created',
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          resolved = true;
        },
        { subscriberName: 'slow' }
      );

      const start = performance.now();
      bus.publishAsync('session.created', { namespaceId: 's1', title: 'T1' });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(10);
      expect(resolved).toBe(false);

      await new Promise((r) => setTimeout(r, 80));
      expect(resolved).toBe(true);
    });

    it('should not throw when a handler fails', async () => {
      bus.subscribe(
        'session.created',
        () => {
          throw new Error('async-boom');
        },
        { subscriberName: 'flaky' }
      );

      expect(() =>
        bus.publishAsync('session.created', { namespaceId: 's1', title: 'T1' })
      ).not.toThrow();

      await new Promise((r) => setTimeout(r, 10));
    });

    it('should defer synchronous handlers so they do not run on the caller stack', async () => {
      let handlerRan = false;
      bus.subscribe(
        'session.created',
        () => {
          handlerRan = true;
        },
        { subscriberName: 'sync' }
      );

      bus.publishAsync('session.created', { namespaceId: 's1', title: 'T1' });
      expect(handlerRan).toBe(false);

      await new Promise((r) => queueMicrotask(r));
      expect(handlerRan).toBe(true);
    });
  });

  describe('createInternalEventBus factory', () => {
    it('should produce a working typed bus', async () => {
      const factoryBus = createInternalEventBus<TestEventMap>();
      const hits: string[] = [];

      factoryBus.subscribe(
        'session.created',
        (data) => {
          hits.push(data.namespaceId);
        },
        { subscriberName: 'factory-sub' }
      );

      const result = await factoryBus.publish('session.created', {
        namespaceId: 'factory-test',
        title: 'Factory Test',
      });

      expect(hits).toEqual(['factory-test']);
      expect(result.delivered).toBe(1);
    });
  });

  describe('diagnostics', () => {
    it('should report correct handler counts', () => {
      expect(bus.getHandlerCount('session.created')).toBe(0);

      bus.subscribe('session.created', () => {}, { subscriberName: 'a' });
      bus.subscribe('session.created', () => {}, { subscriberName: 'b' });
      bus.subscribe('session.created', () => {}, { subscriberName: 'c', namespaceId: 's1' });

      expect(bus.getHandlerCount('session.created')).toBe(3);
      expect(bus.getHandlerCountForNamespace('session.created', 's1')).toBe(1);
      expect(bus.getHandlerCountForNamespace('session.created', 's2')).toBe(0);
    });

    it('should clear all handlers', async () => {
      const hits: string[] = [];
      bus.subscribe('session.created', () => hits.push('a'), { subscriberName: 'a' });
      bus.subscribe('session.updated', () => hits.push('b'), { subscriberName: 'b' });

      bus.clear();

      await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
      await bus.publish('session.updated', { namespaceId: 's1' });

      expect(hits).toHaveLength(0);
    });

    it('should clear handlers for a specific event via off()', async () => {
      const hits: string[] = [];
      bus.subscribe('session.created', () => hits.push('created'), { subscriberName: 'c' });
      bus.subscribe('session.deleted', () => hits.push('deleted'), { subscriberName: 'd' });

      bus.off('session.created');

      await bus.publish('session.created', { namespaceId: 's1', title: 'T1' });
      await bus.publish('session.deleted', { namespaceId: 's1' });

      expect(hits).toEqual(['deleted']);
    });
  });
});

describe('InternalEventBus keyed interface compatibility', () => {
  it('should accept interface-style event maps without a string index signature', async () => {
    const keyedBus = new InternalEventBus<KeyedInterfaceEventMap>();
    const hits: string[] = [];

    keyedBus.subscribe(
      'order.placed',
      (data) => {
        hits.push(data.orderId);
      },
      { subscriberName: 'orders' }
    );

    const result = await keyedBus.publish('order.placed', {
      namespaceId: 's1',
      orderId: 'ord-123',
    });

    expect(hits).toEqual(['ord-123']);
    expect(result.delivered).toBe(1);
  });
});

describe('DaemonInternalEventMap — settings.updated end-to-end', () => {
  it('should flow through createDaemonInternalEventBus with typed payload', async () => {
    const bus = createDaemonInternalEventBus();
    const received: Array<{ namespaceId: string; settings: Record<string, unknown> }> = [];

    bus.subscribe(
      'settings.updated',
      (data) => {
        received.push(data);
      },
      { subscriberName: 'test-sub' }
    );

    const result = await bus.publish('settings.updated', {
      namespaceId: 'global',
      settings: {
        model: 'claude-sonnet-4',
      } as unknown as import('@hyperneo/shared').GlobalSettings,
    });

    expect(result.delivered).toBe(1);
    expect(result.failures).toHaveLength(0);
    expect(received).toHaveLength(1);
    expect(received[0].namespaceId).toBe('global');
    expect(received[0].settings).toEqual({ model: 'claude-sonnet-4' });
  });

  it('should fire-and-forget via publishAsync', async () => {
    const bus = createDaemonInternalEventBus();
    let resolved = false;

    bus.subscribe(
      'settings.updated',
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        resolved = true;
      },
      { subscriberName: 'slow' }
    );

    const start = performance.now();
    bus.publishAsync('settings.updated', {
      namespaceId: 'global',
      settings: {} as unknown as import('@hyperneo/shared').GlobalSettings,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
    expect(resolved).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(true);
  });
});
