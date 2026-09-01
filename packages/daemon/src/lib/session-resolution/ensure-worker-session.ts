import type { EnsureSessionOutcome, SessionTargetWorker } from './target.ts';
import type { SessionResolutionDeps } from './deps.ts';

export function ensureWorkerSession(
  _target: SessionTargetWorker,
  _deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  throw new Error('session-resolution: ensureWorkerSession not implemented');
}
