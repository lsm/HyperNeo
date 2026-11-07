import { describe, expect, it } from 'vitest';
import { decideSessionOpen, decideReopenFailure } from '../../../../src/lib/oap/oap-session-open';

describe('decideSessionOpen', () => {
  it('opens a new session without a native id', () => {
    expect(decideSessionOpen({ nativeSessionId: undefined, supportsReopen: true })).toEqual({
      mode: 'new',
    });
  });

  it('reopens when a native id and reopen capability exist', () => {
    expect(
      decideSessionOpen({ nativeSessionId: 'thread-synthetic', supportsReopen: true })
    ).toEqual({
      mode: 'reopen',
      nativeSessionId: 'thread-synthetic',
    });
  });

  it('does not silently discard history when reopen is unavailable', () => {
    expect(
      decideSessionOpen({ nativeSessionId: 'thread-synthetic', supportsReopen: false })
    ).toEqual({
      mode: 'unavailable',
    });
  });
});

describe('decideReopenFailure', () => {
  it('permits a summary open only for unknown session or unsupported reopen', () => {
    expect(decideReopenFailure({ code: 'unknown_session' })).toEqual({ mode: 'summary' });
    expect(
      decideReopenFailure({ code: 'unsupported_feature', feature: 'session.open.reopen' })
    ).toEqual({
      mode: 'summary',
    });
  });

  it('preserves infrastructure failures and unrelated unsupported features', () => {
    for (const error of [
      { code: 'connection_lost' },
      { code: 'unsupported_feature', feature: 'run.cancel' },
      { code: 'unsupported_feature' },
    ]) {
      expect(decideReopenFailure(error)).toEqual({ mode: 'error', error });
    }
  });
});
