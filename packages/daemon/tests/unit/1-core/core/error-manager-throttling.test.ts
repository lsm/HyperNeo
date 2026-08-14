/**
 * Error throttling tests
 *
 * Verifies that ErrorManager throttles duplicate errors to prevent
 * flooding clients with hundreds of identical connection errors.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ErrorManager, ErrorCategory } from '../../../../src/lib/error-manager';
import { MessageHub } from '@hyperneo/shared';
import {
  createDaemonInternalEventBus,
  type InternalEventBus,
} from '../../../../src/lib/internal-event-bus';

describe('ErrorManager - Error Throttling', () => {
  let errorManager: ErrorManager;
  let messageHub: MessageHub;
  let internalEventBus: InternalEventBus<any>;
  let broadcastedErrors: unknown[] = [];

  beforeEach(async () => {
    broadcastedErrors = [];

    // Mock MessageHub (still needed for API connection status)
    messageHub = {
      event: async () => {},
      onRequest: (_method: string, _handler: Function) => () => {},
      query: async () => ({}),
      command: async () => {},
    } as unknown as MessageHub;

    // Create InternalEventBus
    internalEventBus = createDaemonInternalEventBus();

    internalEventBus.subscribe(
      'session.error',
      (data) => {
        broadcastedErrors.push(data);
      },
      { subscriberName: 'error-manager-throttling-test' }
    );

    errorManager = new ErrorManager(messageHub, internalEventBus);
  });

  it('should allow first 3 identical errors through', async () => {
    const sessionId = 'test-session';

    // Simulate 3 identical connection errors
    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3);
  });

  it('should throttle after 3 identical errors in 10s window', async () => {
    const sessionId = 'test-session';

    // Simulate 100 identical connection errors (like during internet outage)
    for (let i = 0; i < 100; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    // Should only broadcast first 3, rest throttled
    expect(broadcastedErrors.length).toBe(3);
  });

  it('should allow different error types through', async () => {
    const sessionId = 'test-session';

    // Different error categories/codes should not be throttled together
    await errorManager.handleError(
      sessionId,
      new Error('ENOTFOUND api.anthropic.com'),
      ErrorCategory.CONNECTION
    );

    await errorManager.handleError(
      sessionId,
      new Error('401 Unauthorized'),
      ErrorCategory.AUTHENTICATION
    );

    await errorManager.handleError(
      sessionId,
      new Error('429 Rate Limited'),
      ErrorCategory.RATE_LIMIT
    );

    expect(broadcastedErrors.length).toBe(3);
  });

  it('should continue throttling beyond 3 errors', async () => {
    const sessionId = 'test-session';

    // First 3 errors - allowed
    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3);

    // Next 10 errors - should all be throttled
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3); // Still only 3
  });

  it('should NEVER throttle delivery-terminal errors (auth/permission/quota)', async () => {
    // The message-delivery bridge classifies a turn from `session.error`; a
    // throttled 4th rapid auth failure would misclassify as recoverable and
    // burn the retry budget against a credential that cannot succeed. Terminal
    // turns dead-letter on the first occurrence, so there is no storm to damp.
    // (Codex P2.)
    const sessionId = 'test-session';

    // provider_auth_error (expired token — recoverable flag is true, but the
    // delivery classifier treats the category as terminal).
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('OAuth token expired'),
        ErrorCategory.PROVIDER_AUTH_ERROR
      );
    }

    // Non-recoverable: invalid API key / permission / quota.
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('invalid_api_key'),
        ErrorCategory.AUTHENTICATION
      );
    }
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('403 forbidden'),
        ErrorCategory.PERMISSION
      );
    }
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('insufficient_quota'),
        ErrorCategory.RATE_LIMIT
      );
    }

    expect(broadcastedErrors.length).toBe(40);
  });

  it('should still throttle recoverable errors after a terminal error was broadcast', async () => {
    const sessionId = 'test-session';

    await errorManager.handleError(
      sessionId,
      new Error('OAuth token expired'),
      ErrorCategory.PROVIDER_AUTH_ERROR
    );

    // Recoverable connection errors keep their own throttle budget — the
    // terminal exemption does not open the floodgate for recoverable storms.
    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(4); // 1 terminal + 3 connection
  });

  it('should throttle per-session (different sessions get separate limits)', async () => {
    const session1 = 'session-1';
    const session2 = 'session-2';

    // Session 1: 3 errors
    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        session1,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    // Session 2: 3 errors
    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        session2,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    // Both sessions should get their own quota of 3 errors
    expect(broadcastedErrors.length).toBe(6);

    // 4th error for each session should be throttled
    await errorManager.handleError(
      session1,
      new Error('ENOTFOUND api.anthropic.com'),
      ErrorCategory.CONNECTION
    );
    await errorManager.handleError(
      session2,
      new Error('ENOTFOUND api.anthropic.com'),
      ErrorCategory.CONNECTION
    );

    expect(broadcastedErrors.length).toBe(6); // Still 6
  });
});
