/**
 * Connection Error Types
 *
 * Proper error hierarchy for connection-related issues.
 * These errors enable better error handling and user feedback.
 */

/**
 * Base class for all connection-related errors
 *
 * Consumers can use `error instanceof ConnectionError` to catch any connection error.
 * @public - Intentionally exported as base class for error hierarchy
 */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when an operation is attempted but connection is not ready
 */
export class ConnectionNotReadyError extends ConnectionError {
  constructor(message = 'Connection not ready') {
    super(message);
    this.name = 'ConnectionNotReadyError';
  }
}

/**
 * Thrown when connection attempt times out
 */
export class ConnectionTimeoutError extends ConnectionError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message || `Connection timed out after ${timeoutMs}ms`);
    this.name = 'ConnectionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
