import { describe, it, expect } from 'vitest';
import { sanitizeUserError, isAuthError, isTransientError } from '../user-error';

describe('sanitizeUserError', () => {
  describe('user-friendly messages pass through', () => {
    it('should pass through already-friendly messages', () => {
      expect(sanitizeUserError('Please try again.')).toBe('Please try again.');
      expect(sanitizeUserError('Cannot send messages to archived sessions')).toBe(
        'Cannot send messages to archived sessions'
      );
    });
  });

  describe('internal error messages are sanitized', () => {
    it('should sanitize "WebSocket not connected"', () => {
      const result = sanitizeUserError(new Error('WebSocket not connected'));
      expect(result).toBe('Connection lost. Your message will be sent when reconnected.');
    });

    it('should sanitize "Failed to send message: ..."', () => {
      const result = sanitizeUserError(new Error('Failed to send message: socket hang up'));
      expect(result).toBe('Could not send. Please try again.');
    });

    it('should sanitize fetch errors', () => {
      const result = sanitizeUserError(new Error('fetch() failed with verbose: true'));
      expect(result).toBe('Network error. Please check your connection.');
    });

    it('should sanitize ECONNREFUSED', () => {
      const result = sanitizeUserError(new Error('connect ECONNREFUSED 127.0.0.1:9283'));
      expect(result).toBe('Could not reach the server. Please check your connection.');
    });

    it('should sanitize timeout errors', () => {
      const result = sanitizeUserError(new Error('Request timed out after 10000ms'));
      expect(result).toBe('The request timed out. Please try again.');
    });
  });

  describe('edge cases', () => {
    it('should handle null', () => {
      expect(sanitizeUserError(null)).toBe('Something went wrong.');
    });

    it('should handle undefined', () => {
      expect(sanitizeUserError(undefined)).toBe('Something went wrong.');
    });

    it('should handle non-Error objects', () => {
      expect(sanitizeUserError({ code: 'ERR_FAIL' })).toBe(
        'Something went wrong. Please try again.'
      );
    });

    it('should handle empty string', () => {
      expect(sanitizeUserError('')).toBe('Something went wrong.');
    });

    it('should never surface "verbose: true" suggestion', () => {
      const raw = new Error('fetch failed. Try setting verbose: true to get more information.');
      const result = sanitizeUserError(raw);
      expect(result).not.toContain('verbose');
      expect(result).not.toContain('VERBOSE');
    });

    it('should never surface stack traces', () => {
      const err = new Error('something');
      err.stack = 'Error: something\n    at Object.<anonymous> (file.js:1:1)';
      const result = sanitizeUserError(err.stack);
      expect(result).not.toContain('at Object');
    });
  });
});

describe('isAuthError', () => {
  it('should detect "unauthorized"', () => {
    expect(isAuthError(new Error('Unauthorized access'))).toBe(true);
  });

  it('should detect "authentication failed"', () => {
    expect(isAuthError(new Error('Authentication failed'))).toBe(true);
  });

  it('should detect "session expired"', () => {
    expect(isAuthError(new Error('Session expired'))).toBe(true);
  });

  it('should detect "401"', () => {
    expect(isAuthError(new Error('HTTP 401'))).toBe(true);
  });

  it('should NOT flag transient errors as auth errors', () => {
    expect(isAuthError(new Error('Network timeout'))).toBe(false);
    expect(isAuthError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('should NOT flag 403 as auth error (permission denied, not session expiry)', () => {
    expect(isAuthError(new Error('HTTP 403 Forbidden'))).toBe(false);
  });

  it('should handle null/undefined', () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('isTransientError', () => {
  it('should detect timeout errors', () => {
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
  });

  it('should detect network errors', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true);
  });

  it('should detect ECONNRESET', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
  });

  it('should NOT flag auth errors as transient', () => {
    expect(isTransientError(new Error('Unauthorized'))).toBe(false);
  });

  it('should handle null as transient (safe default)', () => {
    expect(isTransientError(null)).toBe(true);
  });
});
