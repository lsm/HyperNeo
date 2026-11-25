export type SessionOpenDecision =
  | { mode: 'new' }
  | { mode: 'reopen'; nativeSessionId: string }
  | { mode: 'unavailable' };

export function decideSessionOpen(input: {
  nativeSessionId: string | undefined;
  supportsReopen: boolean;
}): SessionOpenDecision {
  if (!input.nativeSessionId) return { mode: 'new' };
  if (!input.supportsReopen) return { mode: 'unavailable' };
  return { mode: 'reopen', nativeSessionId: input.nativeSessionId };
}

export function decideReopenFailure<T extends { code: string; feature?: string }>(
  error: T
): { mode: 'summary' } | { mode: 'error'; error: T } {
  if (
    error.code === 'unknown_session' ||
    (error.code === 'unsupported_feature' && error.feature === 'session.open.reopen')
  ) {
    return { mode: 'summary' };
  }
  return { mode: 'error', error };
}
