/** @public */
export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ConnectionNotReadyError extends ConnectionError {
  constructor(message = 'Connection not ready') {
    super(message);
    this.name = 'ConnectionNotReadyError';
  }
}

export class ConnectionTimeoutError extends ConnectionError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number, message?: string) {
    super(message || `Connection timed out after ${timeoutMs}ms`);
    this.name = 'ConnectionTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
