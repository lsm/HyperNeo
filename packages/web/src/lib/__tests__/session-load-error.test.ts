import { describe, it, expect } from 'vitest';
import {
  classifySessionLoadError,
  describeUnavailable,
  isHardUnavailable,
  loadErrorMessage,
} from '../session-load-error';

const CONN = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  disconnected: 'disconnected',
  error: 'error',
  failed: 'failed',
} as const;

describe('classifySessionLoadError', () => {
  it('classifies a "Session not found" reply as not-found even while reconnecting', () => {
    const r = classifySessionLoadError(new Error('Session not found'), CONN.reconnecting);
    expect(r.kind).toBe('not-found');
    expect(r.message).toBe(loadErrorMessage('not-found'));
  });

  it('classifies the liveQuery "Unauthorized: session … not found" guard as not-found', () => {
    const r = classifySessionLoadError(
      new Error('Unauthorized: session "abc" not found'),
      CONN.connected
    );
    expect(r.kind).toBe('not-found');
  });

  it('classifies a request timeout as timeout', () => {
    const r = classifySessionLoadError(
      new Error('Request timeout: state.session (10000ms)'),
      CONN.connected
    );
    expect(r.kind).toBe('timeout');
  });

  it('classifies a synchronous "Not connected to transport" as disconnected', () => {
    const r = classifySessionLoadError(new Error('Not connected to transport'), CONN.disconnected);
    expect(r.kind).toBe('disconnected');
  });

  it('falls back to the transport state for a generic error', () => {
    const r = classifySessionLoadError(new Error('something broke'), CONN.reconnecting);
    expect(r.kind).toBe('disconnected');
  });

  it('classifies a generic error as unknown when the transport is healthy', () => {
    const r = classifySessionLoadError(new Error('something broke'), CONN.connected);
    expect(r.kind).toBe('unknown');
  });

  it('classifies an unauthorized/forbidden reply as unauthorized', () => {
    expect(classifySessionLoadError(new Error('Forbidden'), CONN.connected).kind).toBe(
      'unauthorized'
    );
    expect(classifySessionLoadError(new Error('Unauthorized access'), CONN.connected).kind).toBe(
      'unauthorized'
    );
  });

  it('handles non-Error throws', () => {
    const r = classifySessionLoadError('Session not found', CONN.connected);
    expect(r.kind).toBe('not-found');
  });
});

describe('isHardUnavailable', () => {
  it.each([
    'not-found',
    'unauthorized',
    'archived',
    'terminated',
  ] as const)('%s is hard-unavailable', (kind) => {
    expect(isHardUnavailable(kind)).toBe(true);
  });

  it.each([
    'disconnected',
    'timeout',
    'unknown',
  ] as const)('%s is transient (NOT hard-unavailable)', (kind) => {
    expect(isHardUnavailable(kind)).toBe(false);
  });

  it('null/undefined is not hard-unavailable', () => {
    expect(isHardUnavailable(null)).toBe(false);
    expect(isHardUnavailable(undefined)).toBe(false);
  });
});

describe('describeUnavailable', () => {
  it('returns distinct heading/detail per kind', () => {
    const notFound = describeUnavailable('not-found');
    const archived = describeUnavailable('archived');
    const unauthorized = describeUnavailable('unauthorized');
    expect(notFound.heading).not.toBe(archived.heading);
    expect(archived.heading).not.toBe(unauthorized.heading);
    for (const kind of [
      'not-found',
      'archived',
      'terminated',
      'unauthorized',
      'disconnected',
      'timeout',
      'unknown',
    ] as const) {
      const d = describeUnavailable(kind);
      expect(d.heading).not.toContain('Failed to load session');
      expect(d.detail.length).toBeGreaterThan(0);
    }
  });
});
