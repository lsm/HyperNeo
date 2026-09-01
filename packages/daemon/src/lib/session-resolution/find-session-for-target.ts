import type { EnsureSessionOutcome, FindTarget } from './target.ts';
import type { SessionResolutionDeps } from './deps.ts';

export function findSessionForTarget(
  _target: FindTarget,
  _deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  throw new Error('session-resolution: findSessionForTarget not implemented');
}
