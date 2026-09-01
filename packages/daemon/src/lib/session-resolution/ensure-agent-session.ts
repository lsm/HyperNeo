import type { EnsureSessionOutcome, SessionTargetAgent } from './target.ts';
import type { SessionResolutionDeps } from './deps.ts';

export function ensureAgentSession(
  _target: SessionTargetAgent,
  _deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  throw new Error('session-resolution: ensureAgentSession not implemented');
}
