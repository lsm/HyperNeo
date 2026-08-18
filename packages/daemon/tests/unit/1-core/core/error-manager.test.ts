import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ErrorManager, ErrorCategory } from '../../../../src/lib/error-manager';
import { MessageHub } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';

describe('ErrorManager', () => {
  let errorManager: ErrorManager;
  let mockMessageHub: MessageHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let publishSpy: ReturnType<typeof mock>;
  let internalPublishAsyncSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    internalPublishAsyncSpy = mock(() => {});
    mockInternalEventBus = {
      publishAsync: internalPublishAsyncSpy,
    } as unknown as InternalEventBus<any>;

    errorManager = new ErrorManager(mockMessageHub, mockInternalEventBus);
  });

  describe('createError', () => {
    it('should create structured error from Error object', () => {
      const error = new Error('Test error');
      const structured = errorManager.createError(error, ErrorCategory.SYSTEM);

      expect(structured).toMatchObject({
        category: ErrorCategory.SYSTEM,
        message: 'Test error',
        recoverable: true,
      });
      expect(structured.timestamp).toBeDefined();
      expect(structured.userMessage).toBeDefined();
    });

    it('should create structured error from string', () => {
      const structured = errorManager.createError('String error', ErrorCategory.MESSAGE);

      expect(structured).toMatchObject({
        category: ErrorCategory.MESSAGE,
        message: 'String error',
      });
    });

    it('should use custom user message when provided', () => {
      const customMessage = 'Custom user-friendly message';
      const structured = errorManager.createError(
        'Technical error',
        ErrorCategory.SYSTEM,
        customMessage
      );

      expect(structured.userMessage).toBe(customMessage);
    });
  });

  describe('error code extraction', () => {
    it('should extract UNAUTHORIZED code', () => {
      const structured = errorManager.createError(
        new Error('401 unauthorized'),
        ErrorCategory.AUTHENTICATION
      );
      expect(structured.code).toBe('UNAUTHORIZED');
    });

    it('should extract FORBIDDEN code', () => {
      const structured = errorManager.createError(
        new Error('403 forbidden'),
        ErrorCategory.AUTHENTICATION
      );
      expect(structured.code).toBe('FORBIDDEN');
    });

    it('should extract NOT_FOUND code', () => {
      const structured = errorManager.createError(
        new Error('404 not found'),
        ErrorCategory.SESSION
      );
      expect(structured.code).toBe('NOT_FOUND');
    });

    it('should extract RATE_LIMITED code', () => {
      const structured = errorManager.createError(
        new Error('429 rate limit exceeded'),
        ErrorCategory.RATE_LIMIT
      );
      expect(structured.code).toBe('RATE_LIMITED');
    });

    it('should extract TIMEOUT code', () => {
      const structured = errorManager.createError(
        new Error('Request timeout'),
        ErrorCategory.TIMEOUT
      );
      expect(structured.code).toBe('TIMEOUT');
    });

    it('should extract CONNECTION_REFUSED code', () => {
      const structured = errorManager.createError(
        new Error('ECONNREFUSED'),
        ErrorCategory.CONNECTION
      );
      expect(structured.code).toBe('CONNECTION_REFUSED');
    });

    it('should extract HOST_UNREACHABLE code', () => {
      const structured = errorManager.createError(new Error('ENOTFOUND'), ErrorCategory.CONNECTION);
      expect(structured.code).toBe('HOST_UNREACHABLE');
    });

    it('should extract INVALID_API_KEY code', () => {
      const structured = errorManager.createError(
        new Error('invalid_api_key'),
        ErrorCategory.AUTHENTICATION
      );
      expect(structured.code).toBe('INVALID_API_KEY');
    });

    it('should extract MODEL_NOT_FOUND code', () => {
      const structured = errorManager.createError(
        new Error('model_not_found'),
        ErrorCategory.MODEL
      );
      expect(structured.code).toBe('MODEL_NOT_FOUND');
    });

    it('should extract QUOTA_EXCEEDED code', () => {
      const structured = errorManager.createError(
        new Error('insufficient_quota'),
        ErrorCategory.RATE_LIMIT
      );
      expect(structured.code).toBe('QUOTA_EXCEEDED');
    });

    it('should default to UNKNOWN for unrecognized errors', () => {
      const structured = errorManager.createError(
        new Error('Some random error'),
        ErrorCategory.SYSTEM
      );
      expect(structured.code).toBe('UNKNOWN');
    });
  });

  describe('user-friendly messages', () => {
    it('should provide friendly message for authentication errors', () => {
      const structured = errorManager.createError(
        new Error('invalid_api_key'),
        ErrorCategory.AUTHENTICATION
      );
      expect(structured.userMessage).toBe('Invalid API key. Please check your configuration.');
    });

    it('should provide friendly message for connection errors', () => {
      const structured = errorManager.createError(
        new Error('ECONNREFUSED'),
        ErrorCategory.CONNECTION
      );
      expect(structured.userMessage).toBe(
        'Unable to connect to the server. Please check if the service is running.'
      );
    });

    it('should provide friendly message for session not found', () => {
      const structured = errorManager.createError(
        new Error('Session not found'),
        ErrorCategory.SESSION
      );
      expect(structured.userMessage).toBe(
        'Session not found. It may have been deleted or expired.'
      );
    });

    it('should provide friendly message for rate limit errors', () => {
      const structured = errorManager.createError(
        new Error('429 rate limit'),
        ErrorCategory.RATE_LIMIT
      );
      expect(structured.userMessage).toBe(
        'Rate limit exceeded. Please wait a moment before trying again.'
      );
    });

    it('should provide friendly message for model errors', () => {
      const structured = errorManager.createError(
        new Error('model_not_found'),
        ErrorCategory.MODEL
      );
      expect(structured.userMessage).toBe(
        'The requested model is not available. Please choose a different model.'
      );
    });

    it('should provide friendly message for timeout errors', () => {
      const structured = errorManager.createError(new Error('timeout'), ErrorCategory.TIMEOUT);
      expect(structured.userMessage).toBe('Request timed out. Please try again.');
    });

    it('should provide friendly message for validation errors', () => {
      const structured = errorManager.createError(
        new Error('validation failed'),
        ErrorCategory.VALIDATION
      );
      expect(structured.userMessage).toBe(
        'Invalid request. Please check your input and try again.'
      );
    });

    it('should provide friendly message for permission errors', () => {
      const structured = errorManager.createError(
        new Error('permission denied'),
        ErrorCategory.PERMISSION
      );
      expect(structured.userMessage).toBe(
        "Permission denied. You don't have access to this resource."
      );
    });

    it('should handle disk space errors', () => {
      const structured = errorManager.createError(new Error('ENOSPC'), ErrorCategory.SYSTEM);
      expect(structured.userMessage).toBe(
        'Disk space full. Please free up some space and try again.'
      );
    });

    it('should handle memory errors', () => {
      const structured = errorManager.createError(new Error('ENOMEM'), ErrorCategory.SYSTEM);
      expect(structured.userMessage).toBe(
        'Out of memory. Please close some applications and try again.'
      );
    });
  });

  describe('recoverability', () => {
    it('should mark invalid API key as non-recoverable', () => {
      const structured = errorManager.createError(
        new Error('invalid_api_key'),
        ErrorCategory.AUTHENTICATION
      );
      expect(structured.recoverable).toBe(false);
    });

    it('should mark permission errors as non-recoverable', () => {
      const structured = errorManager.createError(
        new Error('permission denied'),
        ErrorCategory.PERMISSION
      );
      expect(structured.recoverable).toBe(false);
    });

    it('should mark quota exceeded as non-recoverable', () => {
      const structured = errorManager.createError(
        new Error('quota exceeded'),
        ErrorCategory.RATE_LIMIT
      );
      expect(structured.recoverable).toBe(false);
    });

    it('should mark timeout errors as recoverable', () => {
      const structured = errorManager.createError(new Error('timeout'), ErrorCategory.TIMEOUT);
      expect(structured.recoverable).toBe(true);
    });

    it('should mark connection errors as recoverable', () => {
      const structured = errorManager.createError(
        new Error('ECONNREFUSED'),
        ErrorCategory.CONNECTION
      );
      expect(structured.recoverable).toBe(true);
    });

    it('should mark most errors as recoverable by default', () => {
      const structured = errorManager.createError(new Error('unknown'), ErrorCategory.SYSTEM);
      expect(structured.recoverable).toBe(true);
    });
  });

  describe('broadcastError', () => {
    it('should emit error via InternalEventBus for StateManager', async () => {
      const sessionId = 'test-session-123';
      const error = errorManager.createError(new Error('test'), ErrorCategory.SYSTEM);

      await errorManager.broadcastError(sessionId, error);

      expect(internalPublishAsyncSpy).toHaveBeenCalledTimes(1);
      expect(internalPublishAsyncSpy.mock.calls[0][0]).toBe('session.error');
      expect(internalPublishAsyncSpy.mock.calls[0][1]).toMatchObject({
        sessionId,
        error: error.userMessage,
      });
    });
  });

  describe('handleError', () => {
    it('should create error and broadcast it', async () => {
      const sessionId = 'test-session-456';
      const errorMessage = 'Test error message';

      const result = await errorManager.handleError(
        sessionId,
        new Error(errorMessage),
        ErrorCategory.MESSAGE
      );

      expect(result.message).toBe(errorMessage);
      expect(result.category).toBe(ErrorCategory.MESSAGE);
      expect(internalPublishAsyncSpy).toHaveBeenCalledTimes(1);
    });

    it('should use custom user message when provided', async () => {
      const sessionId = 'test-session-789';
      const customMessage = 'Custom error message';

      const result = await errorManager.handleError(
        sessionId,
        new Error('Technical error'),
        ErrorCategory.SYSTEM,
        customMessage
      );

      expect(result.userMessage).toBe(customMessage);
    });

    it('should handle string errors', async () => {
      const sessionId = 'test-session-abc';
      const result = await errorManager.handleError(
        sessionId,
        'String error',
        ErrorCategory.SYSTEM
      );

      expect(result.message).toBe('String error');
      expect(internalPublishAsyncSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('error categories', () => {
    it('should handle all error categories', () => {
      const categories = [
        ErrorCategory.AUTHENTICATION,
        ErrorCategory.CONNECTION,
        ErrorCategory.SESSION,
        ErrorCategory.MESSAGE,
        ErrorCategory.MODEL,
        ErrorCategory.SYSTEM,
        ErrorCategory.VALIDATION,
        ErrorCategory.TIMEOUT,
        ErrorCategory.PERMISSION,
        ErrorCategory.RATE_LIMIT,
        ErrorCategory.PROVIDER_AUTH_ERROR,
        ErrorCategory.PROVIDER_UNAVAILABLE,
      ];

      categories.forEach((category) => {
        const structured = errorManager.createError(new Error('test'), category);
        expect(structured.category).toBe(category);
        expect(structured.userMessage).toBeDefined();
        expect(structured.userMessage.length).toBeGreaterThan(0);
      });
    });
  });

  describe('provider error categories', () => {
    it('should generate correct user message for PROVIDER_AUTH_ERROR', () => {
      const structured = errorManager.createError(
        new Error('401 unauthorized'),
        ErrorCategory.PROVIDER_AUTH_ERROR
      );
      expect(structured.category).toBe(ErrorCategory.PROVIDER_AUTH_ERROR);
      expect(structured.userMessage).toContain('Authentication with the provider has expired');
      expect(structured.userMessage).toContain('re-authenticate');
    });

    it('should generate correct user message for PROVIDER_UNAVAILABLE', () => {
      const structured = errorManager.createError(
        new Error('ECONNREFUSED bridge'),
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
      expect(structured.category).toBe(ErrorCategory.PROVIDER_UNAVAILABLE);
      expect(structured.userMessage).toContain('temporarily unavailable');
      expect(structured.userMessage).toContain('switch to another provider');
    });

    it('should include provider-specific recovery suggestions for PROVIDER_AUTH_ERROR', () => {
      const structured = errorManager.createError(
        new Error('token expired'),
        ErrorCategory.PROVIDER_AUTH_ERROR
      );
      expect(structured.recoverySuggestions).toBeDefined();
      expect(structured.recoverySuggestions?.length).toBeGreaterThan(0);
      expect(structured.recoverySuggestions).toContain('Open Provider Settings to re-authenticate');
      expect(structured.recoverySuggestions).toContain(
        'Try switching to a different provider temporarily'
      );
    });

    it('should include provider-specific recovery suggestions for PROVIDER_UNAVAILABLE', () => {
      const structured = errorManager.createError(
        new Error('service unavailable 503'),
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
      expect(structured.recoverySuggestions).toBeDefined();
      expect(structured.recoverySuggestions?.length).toBeGreaterThan(0);
      expect(structured.recoverySuggestions).toContain(
        'Switch to a different provider (e.g. Anthropic) from the model picker'
      );
      expect(structured.recoverySuggestions).toContain(
        'Check that the provider bridge server is running'
      );
    });

    it('PROVIDER_AUTH_ERROR should be recoverable', () => {
      const structured = errorManager.createError(
        new Error('token expired'),
        ErrorCategory.PROVIDER_AUTH_ERROR
      );
      expect(structured.recoverable).toBe(true);
    });

    it('PROVIDER_UNAVAILABLE should be recoverable', () => {
      const structured = errorManager.createError(
        new Error('ECONNREFUSED'),
        ErrorCategory.PROVIDER_UNAVAILABLE
      );
      expect(structured.recoverable).toBe(true);
    });

    it('should track PROVIDER_UNAVAILABLE errors in API connection state', async () => {
      for (let i = 0; i < 2; i++) {
        const error = errorManager.createError(
          new Error('bridge server unreachable'),
          ErrorCategory.PROVIDER_UNAVAILABLE
        );
        await errorManager.broadcastError('test-session', error);
      }

      const state = errorManager.getApiConnectionState();
      expect(state.status).toBe('degraded');
    });

    it('should use custom user message for provider auth errors', () => {
      const customMessage = 'Authentication with Copilot has expired. Please re-authenticate.';
      const structured = errorManager.createError(
        new Error('401 unauthorized'),
        ErrorCategory.PROVIDER_AUTH_ERROR,
        customMessage
      );
      expect(structured.userMessage).toBe(customMessage);
    });

    it('should store provider metadata when provided', async () => {
      const result = await errorManager.handleError(
        'session-abc',
        new Error('token expired'),
        ErrorCategory.PROVIDER_AUTH_ERROR,
        'Authentication with Copilot has expired.',
        undefined,
        { providerId: 'anthropic-copilot', providerName: 'Copilot' }
      );

      expect(result.category).toBe(ErrorCategory.PROVIDER_AUTH_ERROR);
      expect(result.metadata?.providerId).toBe('anthropic-copilot');
      expect(result.metadata?.providerName).toBe('Copilot');
    });
  });

  describe('rich error context', () => {
    it('should include stack trace from Error objects', () => {
      const error = new Error('Test error with stack');
      const structured = errorManager.createError(error, ErrorCategory.SYSTEM);

      expect(structured.stack).toBeDefined();
      expect(structured.stack).toContain('Test error with stack');
    });

    it('should not include stack trace for string errors', () => {
      const structured = errorManager.createError('String error', ErrorCategory.SYSTEM);

      expect(structured.stack).toBeUndefined();
    });

    it('should include session context when provided', () => {
      const sessionContext = {
        sessionId: 'test-session-123',
        processingState: {
          status: 'processing',
          messageId: 'msg-456',
          phase: 'thinking',
        },
      };

      const structured = errorManager.createError(
        new Error('test'),
        ErrorCategory.MESSAGE,
        undefined,
        sessionContext
      );

      expect(structured.sessionContext).toEqual(sessionContext);
      expect(structured.sessionContext?.sessionId).toBe('test-session-123');
      expect(structured.sessionContext?.processingState?.status).toBe('processing');
      expect(structured.sessionContext?.processingState?.phase).toBe('thinking');
    });

    it('should include metadata when provided', () => {
      const metadata = {
        queueSize: 5,
        errorMessage: 'Network timeout',
        requestedModel: 'claude-3-opus',
      };

      const structured = errorManager.createError(
        new Error('test'),
        ErrorCategory.SYSTEM,
        undefined,
        undefined,
        metadata
      );

      expect(structured.metadata).toEqual(metadata);
    });

    it('should include recovery suggestions', () => {
      const structured = errorManager.createError(
        new Error('invalid_api_key'),
        ErrorCategory.AUTHENTICATION
      );

      expect(structured.recoverySuggestions).toBeDefined();
      expect(structured.recoverySuggestions?.length).toBeGreaterThan(0);
      expect(structured.recoverySuggestions).toContain(
        'Check your API key in environment variables'
      );
      expect(structured.recoverySuggestions).toContain(
        'Ensure ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set correctly'
      );
    });

    it('should include recovery suggestions for all categories', () => {
      const categories = [
        ErrorCategory.AUTHENTICATION,
        ErrorCategory.CONNECTION,
        ErrorCategory.MESSAGE,
        ErrorCategory.MODEL,
        ErrorCategory.SESSION,
        ErrorCategory.RATE_LIMIT,
      ];

      categories.forEach((category) => {
        const structured = errorManager.createError(new Error('test'), category);
        expect(structured.recoverySuggestions).toBeDefined();
        expect(structured.recoverySuggestions?.length).toBeGreaterThan(0);
      });
    });

    it('should provide different suggestions based on error code', () => {
      const quotaError = errorManager.createError(
        new Error('quota exceeded'),
        ErrorCategory.RATE_LIMIT
      );
      const rateLimitError = errorManager.createError(
        new Error('429 rate limit'),
        ErrorCategory.RATE_LIMIT
      );

      expect(quotaError.recoverySuggestions).toContain('Check your API usage limits');
      expect(rateLimitError.recoverySuggestions).toContain(
        'Wait a few moments before trying again'
      );
    });
  });

  describe('handleError with rich context', () => {
    it('should include processing state in error context', async () => {
      const sessionId = 'test-session-789';
      const processingState = {
        status: 'processing',
        messageId: 'msg-123',
        phase: 'streaming',
      };

      const result = await errorManager.handleError(
        sessionId,
        new Error('Test error'),
        ErrorCategory.MESSAGE,
        undefined,
        processingState
      );

      expect(result.sessionContext?.sessionId).toBe(sessionId);
      expect(result.sessionContext?.processingState).toEqual(processingState);
    });

    it('should include metadata in error context', async () => {
      const sessionId = 'test-session-abc';
      const metadata = {
        messageType: 'assistant',
        queueSize: 3,
      };

      const result = await errorManager.handleError(
        sessionId,
        new Error('Test error'),
        ErrorCategory.MESSAGE,
        undefined,
        undefined,
        metadata
      );

      expect(result.metadata).toEqual(metadata);
    });

    it('should emit error via InternalEventBus', async () => {
      const sessionId = 'test-session-def';
      const processingState = {
        status: 'processing',
        messageId: 'msg-789',
      };
      const metadata = { testData: 'test' };

      await errorManager.handleError(
        sessionId,
        new Error('Test error'),
        ErrorCategory.SYSTEM,
        'Custom message',
        processingState,
        metadata
      );

      expect(internalPublishAsyncSpy).toHaveBeenCalledTimes(1);
      expect(internalPublishAsyncSpy.mock.calls[0][0]).toBe('session.error');
      const emittedData = internalPublishAsyncSpy.mock.calls[0][1];

      expect(emittedData.sessionId).toBe(sessionId);
      expect(emittedData.error).toBe('Custom message');
      expect(emittedData.details.sessionContext?.sessionId).toBe(sessionId);
      expect(emittedData.details.sessionContext?.processingState).toEqual(processingState);
      expect(emittedData.details.metadata).toEqual(metadata);
      expect(emittedData.details.recoverySuggestions).toBeDefined();
      expect(emittedData.details.stack).toBeDefined();
    });

    it('should capture additional error properties', () => {
      const error = new Error('Custom error');
      (error as unknown as Record<string, unknown>).code = 'CUSTOM_CODE';
      (error as unknown as Record<string, unknown>).statusCode = 500;
      (error as unknown as Record<string, unknown>).details = { foo: 'bar' };

      const structured = errorManager.createError(error, ErrorCategory.SYSTEM);

      expect(structured.metadata).toMatchObject({
        error_code: 'CUSTOM_CODE',
        error_statusCode: 500,
        error_details: { foo: 'bar' },
      });
    });

    it('should capture error.cause if present', () => {
      const cause = new Error('Root cause error');
      const error = new Error('Wrapper error', { cause });

      const structured = errorManager.createError(error, ErrorCategory.SYSTEM);

      expect(structured.metadata).toBeDefined();
      const errorCause = structured.metadata?.errorCause as {
        message: string;
        stack: string;
      };
      expect(errorCause).toBeDefined();
      expect(errorCause.message).toBe('Root cause error');
      expect(errorCause.stack).toBeDefined();
    });
  });

  describe('API connection state', () => {
    it('should return initial connection state', () => {
      const state = errorManager.getApiConnectionState();

      expect(state.status).toBe('connected');
      expect(state.errorCount).toBe(0);
      expect(state.lastError).toBeUndefined();
      expect(state.timestamp).toBeDefined();
    });

    it('should track connection errors and update status', async () => {
      for (let i = 0; i < 5; i++) {
        const error = errorManager.createError(
          new Error('ENOTFOUND api.anthropic.com'),
          ErrorCategory.CONNECTION
        );
        await errorManager.broadcastError('test-session', error);
      }

      const state = errorManager.getApiConnectionState();
      expect(state.status).toBe('disconnected');
      expect(state.errorCount).toBe(5);
    });

    it('should mark API success and reset error count', async () => {
      for (let i = 0; i < 3; i++) {
        const error = errorManager.createError(new Error('ENOTFOUND'), ErrorCategory.CONNECTION);
        await errorManager.broadcastError('test-session', error);
      }

      let state = errorManager.getApiConnectionState();
      expect(state.status).toBe('degraded');
      expect(state.errorCount).toBe(3);

      await errorManager.markApiSuccess();

      state = errorManager.getApiConnectionState();
      expect(state.status).toBe('connected');
      expect(state.errorCount).toBe(0);
      expect(state.lastSuccessfulCall).toBeDefined();
    });

    it('should emit api.connection event on recovery', async () => {
      for (let i = 0; i < 2; i++) {
        const error = errorManager.createError(new Error('ECONNREFUSED'), ErrorCategory.CONNECTION);
        await errorManager.broadcastError('test-session', error);
      }

      internalPublishAsyncSpy.mockClear();

      await errorManager.markApiSuccess();

      const apiConnectionCalls = internalPublishAsyncSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'api.connection'
      );
      expect(apiConnectionCalls.length).toBe(1);
      expect(apiConnectionCalls[0][1]).toMatchObject({
        status: 'connected',
        errorCount: 0,
      });
    });

    it('should not emit recovery event if already connected', async () => {
      internalPublishAsyncSpy.mockClear();

      await errorManager.markApiSuccess();

      const apiConnectionCalls = internalPublishAsyncSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'api.connection'
      );
      expect(apiConnectionCalls.length).toBe(0);
    });
  });
});
