import { beforeEach, describe, expect, test } from 'bun:test';
import { ErrorCode, MessageType, createRequestMessage } from '../src/message-hub/protocol';
import {
  DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT,
  type ClientConnection,
  MessageHubRouter,
  type RouterLogger,
} from '../src/message-hub/router';
import { MessageHub, MessageHubHandlerError } from '../src/message-hub/message-hub';
import type { ConnectionState, HubMessage, IMessageTransport } from '../src/message-hub/types';
import { generateUUID } from '../src/utils';

function createMockConnection(id?: string): ClientConnection {
  return {
    id: id || generateUUID(),
    send: () => {},
    isOpen: () => true,
  };
}

function createRecordingLogger(): RouterLogger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    log: () => {},
    warn: (msg: string) => warns.push(msg),
    error: () => {},
  };
}

describe('MessageHubRouter subscription cap (ingress fan-out guardrail)', () => {
  describe('default', () => {
    test('is tuned below the observed 790-subscribe task-page fan-out (#2414)', () => {
      expect(DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT).toBeLessThan(790);
      expect(DEFAULT_MAX_SUBSCRIPTIONS_PER_CLIENT).toBe(128);
    });
  });

  describe('checkSubscriptionCapacity', () => {
    let router: MessageHubRouter;
    let logger: ReturnType<typeof createRecordingLogger>;
    const CAP = 4;

    beforeEach(() => {
      logger = createRecordingLogger();
      router = new MessageHubRouter({ logger, maxSubscriptionsPerClient: CAP });
      router.registerConnection(createMockConnection('client-A'));
    });

    test('allows up to the cap, then refuses the next with a structured result', () => {
      for (let i = 0; i < CAP; i++) {
        const check = router.checkSubscriptionCapacity('client-A');
        expect(check.ok).toBe(true);
        router.addClientSubscription('client-A');
      }

      const over = router.checkSubscriptionCapacity('client-A');
      expect(over.ok).toBe(false);
      if (!over.ok) {
        expect(over.reason).toBe('too_many_subscriptions');
        expect(over.limit).toBe(CAP);
        expect(over.current).toBe(CAP);
      }
    });

    test('logs a dev-mode warning when the cap is exceeded', () => {
      for (let i = 0; i < CAP; i++) {
        router.addClientSubscription('client-A');
      }
      router.checkSubscriptionCapacity('client-A');
      expect(logger.warns.length).toBe(1);
      expect(logger.warns[0]).toContain('client-A');
      expect(logger.warns[0]).toContain(`${CAP}/${CAP}`);
    });

    test('check is read-only: a refused check does not change the count', () => {
      for (let i = 0; i < CAP; i++) router.addClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);

      router.checkSubscriptionCapacity('client-A');
      router.checkSubscriptionCapacity('client-A');
      router.checkSubscriptionCapacity('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);
    });
  });

  describe('graceful refusal (no teardown of existing subscriptions)', () => {
    let router: MessageHubRouter;
    const CAP = 3;

    beforeEach(() => {
      router = new MessageHubRouter({ maxSubscriptionsPerClient: CAP });
      router.registerConnection(createMockConnection('client-A'));
    });

    test('prior subscriptions remain intact after an over-cap refusal', () => {
      for (let i = 0; i < CAP; i++) router.addClientSubscription('client-A');
      const before = router.getClientSubscriptionCount('client-A');

      const check = router.checkSubscriptionCapacity('client-A');
      expect(check.ok).toBe(false);

      expect(router.getClientSubscriptionCount('client-A')).toBe(before);
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);
    });

    test('releasing a slot recovers capacity (refusal is not a hard teardown)', () => {
      for (let i = 0; i < CAP; i++) router.addClientSubscription('client-A');
      expect(router.checkSubscriptionCapacity('client-A').ok).toBe(false);

      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP - 1);

      expect(router.checkSubscriptionCapacity('client-A').ok).toBe(true);
      router.addClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);
    });

    test('release floors at zero so a stray release cannot widen the cap', () => {
      router.addClientSubscription('client-A');
      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(0);

      router.releaseClientSubscription('client-A');
      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(0);

      expect(router.checkSubscriptionCapacity('client-A').ok).toBe(true);
    });
  });

  describe('per-client isolation and disconnect reset', () => {
    test('the cap is enforced independently per client', () => {
      const router = new MessageHubRouter({ maxSubscriptionsPerClient: 2 });
      router.registerConnection(createMockConnection('A'));
      router.registerConnection(createMockConnection('B'));

      router.addClientSubscription('A');
      router.addClientSubscription('A');
      router.addClientSubscription('B');

      expect(router.checkSubscriptionCapacity('A').ok).toBe(false);
      expect(router.checkSubscriptionCapacity('B').ok).toBe(true);
    });

    test('unregisterConnection resets that client’s counter (reconciles on disconnect)', () => {
      const router = new MessageHubRouter({ maxSubscriptionsPerClient: 2 });
      router.registerConnection(createMockConnection('A'));
      router.addClientSubscription('A');
      router.addClientSubscription('A');
      expect(router.checkSubscriptionCapacity('A').ok).toBe(false);

      router.unregisterConnection('A');

      expect(router.getClientSubscriptionCount('A')).toBe(0);
      router.registerConnection(createMockConnection('A'));
      expect(router.checkSubscriptionCapacity('A').ok).toBe(true);
    });
  });
});

class CapMockTransport implements IMessageTransport {
  readonly name = 'cap-mock-transport';
  public sentMessages: HubMessage[] = [];
  private handlers: Set<(m: HubMessage) => void> = new Set();
  async initialize(): Promise<void> {}
  async close(): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(message: HubMessage): Promise<void> {
    this.sentMessages.push(message);
  }
  onMessage(h: (m: HubMessage) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  onConnectionChange(): () => void {
    return () => {};
  }
  getState(): ConnectionState {
    return 'connected';
  }
  isReady(): boolean {
    return true;
  }
  simulate(message: HubMessage): void {
    for (const h of this.handlers) h(message);
  }
}

describe('MessageHub structured handler error', () => {
  test('preserves a MessageHubHandlerError code on the error response', async () => {
    const hub = new MessageHub({ defaultSessionId: 's' });
    const transport = new CapMockTransport();
    hub.registerTransport(transport);
    await transport.connect();

    hub.onRequest('test.tooMany', () => {
      throw new MessageHubHandlerError(
        'subscription cap reached (4/4)',
        ErrorCode.TOO_MANY_SUBSCRIPTIONS
      );
    });

    const req = createRequestMessage({ method: 'test.tooMany', data: {}, sessionId: 's' });
    transport.simulate(req);
    await new Promise((r) => setTimeout(r, 10));

    const err = transport.sentMessages.find(
      (m) => m.type === MessageType.RESPONSE && m.requestId === req.id && m.error
    );
    expect(err).toBeDefined();
    expect(err?.errorCode).toBe(ErrorCode.TOO_MANY_SUBSCRIPTIONS);
    expect(err?.error).toContain('4/4');

    hub.cleanup();
  });

  test('a plain thrown Error still maps to HANDLER_ERROR (unchanged behavior)', async () => {
    const hub = new MessageHub({ defaultSessionId: 's' });
    const transport = new CapMockTransport();
    hub.registerTransport(transport);
    await transport.connect();

    hub.onRequest('test.plain', () => {
      throw new Error('boom');
    });

    const req = createRequestMessage({ method: 'test.plain', data: {}, sessionId: 's' });
    transport.simulate(req);
    await new Promise((r) => setTimeout(r, 10));

    const err = transport.sentMessages.find(
      (m) => m.type === MessageType.RESPONSE && m.requestId === req.id && m.error
    );
    expect(err).toBeDefined();
    expect(err?.errorCode).toBe(ErrorCode.HANDLER_ERROR);

    hub.cleanup();
  });
});
