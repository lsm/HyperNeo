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

/**
 * Ingress fan-out guardrail: per-client subscription cap (task #899 / incident #2414).
 *
 * Before this guardrail, `maxSubscriptionsPerClient` was declared but never
 * enforced, so a high-fan-out page silently accumulated one handler per
 * subscribe (790 on one task page) and stalled the client past the 10s RPC
 * timeout. These tests characterize the now-enforced behavior: over-cap
 * subscribes fail fast with a structured error, existing subscriptions are
 * preserved, and dev mode warns loudly.
 */

// Minimal mock connection (matches the pattern in message-hub-router.test.ts)
function createMockConnection(id?: string): ClientConnection {
  return {
    id: id || generateUUID(),
    send: () => {},
    isOpen: () => true,
  };
}

/** Logger that records warn calls so tests can assert the dev-mode warning. */
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
      // A guardrail default that sits above the incident would not trip on the
      // regression it exists to catch.
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

      // The (cap+1)th subscribe is refused — fail fast at the boundary.
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

      // Repeated capacity checks must not drift the counter (a caller that
      // checks then decides not to subscribe must not need to release).
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

      // Simulate the daemon's refusal path: check fails, caller does NOT add.
      const check = router.checkSubscriptionCapacity('client-A');
      expect(check.ok).toBe(false);

      // The cap held — refusing the new subscribe did not evict any existing one.
      expect(router.getClientSubscriptionCount('client-A')).toBe(before);
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);
    });

    test('releasing a slot recovers capacity (refusal is not a hard teardown)', () => {
      for (let i = 0; i < CAP; i++) router.addClientSubscription('client-A');
      expect(router.checkSubscriptionCapacity('client-A').ok).toBe(false);

      // An existing subscription is closed (e.g. user navigates away from a view).
      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP - 1);

      // A new subscribe can now succeed again.
      expect(router.checkSubscriptionCapacity('client-A').ok).toBe(true);
      router.addClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(CAP);
    });

    test('release floors at zero so a stray release cannot widen the cap', () => {
      router.addClientSubscription('client-A');
      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(0);

      // Extra releases on a client with no tracked subscriptions are a no-op.
      router.releaseClientSubscription('client-A');
      router.releaseClientSubscription('client-A');
      expect(router.getClientSubscriptionCount('client-A')).toBe(0);

      // And capacity is still correctly reported as available.
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

      // A is full, B still has headroom.
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

      // Counter is gone; a re-registration starts from a clean slate.
      expect(router.getClientSubscriptionCount('A')).toBe(0);
      router.registerConnection(createMockConnection('A'));
      expect(router.checkSubscriptionCapacity('A').ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Hub error-response plumbing: a MessageHubHandlerError carries its ErrorCode
// onto the wire so the daemon's over-cap refusal reaches the client as a
// structured TOO_MANY_SUBSCRIPTIONS (mirroring #2423's MESSAGE_TOO_LARGE).
// ---------------------------------------------------------------------------

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
