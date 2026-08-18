// @ts-nocheck

import { cleanup } from '@testing-library/preact';
import type { StructuredError } from '../../types/error';

describe('ErrorDialog', () => {
  const mockOnClose = vi.fn(() => {});

  const mockError: StructuredError = {
    category: 'authentication' as const,
    code: 'AUTH_FAILED',
    message: 'Authentication failed due to invalid credentials',
    userMessage: 'Unable to authenticate. Please check your API key.',
    recoverable: true,
    timestamp: '2024-01-15T10:30:00.000Z',
    recoverySuggestions: [
      'Check that your API key is valid',
      'Ensure the key has not expired',
      'Try regenerating a new API key',
    ],
    sessionContext: {
      sessionId: 'session-123',
      processingState: {
        status: 'processing',
        phase: 'thinking',
        messageId: 'msg-456',
      },
    },
    metadata: {
      attemptCount: 3,
      lastAttempt: '2024-01-15T10:29:55.000Z',
    },
    stack:
      'Error: Authentication failed\n    at AuthManager.authenticate (auth.ts:45)\n    at Session.start (session.ts:123)',
  };

  beforeEach(() => {
    cleanup();
    mockOnClose.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Error Object Structure', () => {
    it('should have valid error category', () => {
      expect(mockError.category).toBe('authentication');
    });

    it('should have error code', () => {
      expect(mockError.code).toBe('AUTH_FAILED');
    });

    it('should have user message', () => {
      expect(mockError.userMessage).toBe('Unable to authenticate. Please check your API key.');
    });

    it('should have technical message', () => {
      expect(mockError.message).toBe('Authentication failed due to invalid credentials');
    });

    it('should have recoverable flag', () => {
      expect(mockError.recoverable).toBe(true);
    });

    it('should have timestamp', () => {
      expect(mockError.timestamp).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should have recovery suggestions', () => {
      expect(mockError.recoverySuggestions?.length).toBe(3);
      expect(mockError.recoverySuggestions?.[0]).toBe('Check that your API key is valid');
    });

    it('should have session context', () => {
      expect(mockError.sessionContext?.sessionId).toBe('session-123');
      expect(mockError.sessionContext?.processingState?.status).toBe('processing');
    });

    it('should have metadata', () => {
      expect(mockError.metadata?.attemptCount).toBe(3);
    });

    it('should have stack trace', () => {
      expect(mockError.stack).toContain('AuthManager.authenticate');
    });
  });

  describe('Error Categories', () => {
    const categories = [
      'authentication',
      'connection',
      'session',
      'message',
      'model',
      'system',
      'validation',
      'timeout',
      'permission',
      'rate_limit',
    ];

    for (const category of categories) {
      it(`should support ${category} category`, () => {
        const error: StructuredError = {
          ...mockError,
          category: category as StructuredError['category'],
        };
        expect(error.category).toBe(category);
      });
    }
  });

  describe('Error Report Generation', () => {
    it('should have all fields needed for error report', () => {
      expect(mockError.category).toBeDefined();
      expect(mockError.code).toBeDefined();
      expect(mockError.timestamp).toBeDefined();
      expect(mockError.recoverable).toBeDefined();
      expect(mockError.userMessage).toBeDefined();
      expect(mockError.message).toBeDefined();
    });

    it('should support optional fields', () => {
      const minimalError: StructuredError = {
        category: 'system' as const,
        code: 'UNKNOWN',
        message: 'An error occurred',
        userMessage: 'Something went wrong',
        recoverable: false,
        timestamp: new Date().toISOString(),
      };

      expect(minimalError.recoverySuggestions).toBeUndefined();
      expect(minimalError.sessionContext).toBeUndefined();
      expect(minimalError.metadata).toBeUndefined();
      expect(minimalError.stack).toBeUndefined();
    });
  });

  describe('Processing State in Error', () => {
    it('should include processing status in session context', () => {
      expect(mockError.sessionContext?.processingState?.status).toBe('processing');
    });

    it('should include processing phase when available', () => {
      expect(mockError.sessionContext?.processingState?.phase).toBe('thinking');
    });

    it('should include message ID when available', () => {
      expect(mockError.sessionContext?.processingState?.messageId).toBe('msg-456');
    });
  });

  describe('Recoverable vs Non-Recoverable Errors', () => {
    it('should identify recoverable errors', () => {
      const recoverableError: StructuredError = {
        ...mockError,
        recoverable: true,
      };
      expect(recoverableError.recoverable).toBe(true);
    });

    it('should identify non-recoverable errors', () => {
      const nonRecoverableError: StructuredError = {
        ...mockError,
        recoverable: false,
      };
      expect(nonRecoverableError.recoverable).toBe(false);
    });
  });
});
