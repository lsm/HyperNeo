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

    messageHub = {
      event: async () => {},
      onRequest: (_method: string, _handler: Function) => () => {},
      query: async () => ({}),
      command: async () => {},
    } as unknown as MessageHub;

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

    for (let i = 0; i < 100; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3);
  });

  it('should allow different error types through', async () => {
    const sessionId = 'test-session';

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

    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3);

    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(3);
  });

  it('should NEVER throttle delivery-terminal errors (auth/permission/quota)', async () => {
    const sessionId = 'test-session';

    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('OAuth token expired'),
        ErrorCategory.PROVIDER_AUTH_ERROR
      );
    }

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

    for (let i = 0; i < 10; i++) {
      await errorManager.handleError(
        sessionId,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(4);
  });

  it('should throttle per-session (different sessions get separate limits)', async () => {
    const session1 = 'session-1';
    const session2 = 'session-2';

    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        session1,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    for (let i = 0; i < 3; i++) {
      await errorManager.handleError(
        session2,
        new Error('ENOTFOUND api.anthropic.com'),
        ErrorCategory.CONNECTION
      );
    }

    expect(broadcastedErrors.length).toBe(6);

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

    expect(broadcastedErrors.length).toBe(6);
  });
});
