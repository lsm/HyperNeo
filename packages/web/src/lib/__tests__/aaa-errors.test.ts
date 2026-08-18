// @ts-nocheck

import { ConnectionError, ConnectionNotReadyError, ConnectionTimeoutError } from '../errors';

describe('ConnectionError', () => {
  it('should create a basic ConnectionError', () => {
    const error = new ConnectionError('test error');
    expect(error.message).toBe('test error');
    expect(error.name).toBe('ConnectionError');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConnectionError);
  });

  it('should have proper stack trace', () => {
    const error = new ConnectionError('test');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('ConnectionError');
  });
});

describe('ConnectionNotReadyError', () => {
  it('should create with default message', () => {
    const error = new ConnectionNotReadyError();
    expect(error.message).toBe('Connection not ready');
    expect(error.name).toBe('ConnectionNotReadyError');
  });

  it('should create with custom message', () => {
    const error = new ConnectionNotReadyError('Custom message');
    expect(error.message).toBe('Custom message');
  });

  it('should be instanceof ConnectionError', () => {
    const error = new ConnectionNotReadyError();
    expect(error).toBeInstanceOf(ConnectionError);
  });
});

describe('ConnectionTimeoutError', () => {
  it('should create with timeout value', () => {
    const error = new ConnectionTimeoutError(5000);
    expect(error.message).toBe('Connection timed out after 5000ms');
    expect(error.name).toBe('ConnectionTimeoutError');
    expect(error.timeoutMs).toBe(5000);
  });

  it('should create with custom message', () => {
    const error = new ConnectionTimeoutError(5000, 'Custom timeout message');
    expect(error.message).toBe('Custom timeout message');
    expect(error.timeoutMs).toBe(5000);
  });

  it('should be instanceof ConnectionError', () => {
    const error = new ConnectionTimeoutError(5000);
    expect(error).toBeInstanceOf(ConnectionError);
  });
});
