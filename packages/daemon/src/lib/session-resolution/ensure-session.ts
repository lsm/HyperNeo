import type { EnsureSessionOutcome, SessionTarget } from './target.ts';
import type { SessionResolutionDeps } from './deps.ts';

export function ensureSession(
  _target: SessionTarget,
  _deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  throw new Error('session-resolution: ensureSession not implemented');
}
