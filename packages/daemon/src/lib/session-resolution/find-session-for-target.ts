import type { SessionResolutionDeps } from './deps.ts';
import type { EnsureSessionOutcome, FindTarget } from './target.ts';

export async function findSessionForTarget(
  target: FindTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  if (target.kind === 'session') {
    if ((await deps.getSession(target.sessionId)) !== null) {
      return { kind: 'resolved', sessionId: target.sessionId, created: false };
    }
    if ((await deps.rehydrateSubSession(target.sessionId)) !== null) {
      return { kind: 'resolved', sessionId: target.sessionId, created: false };
    }
    return { kind: 'unresolved', reason: 'not_found' };
  }
  const sessionId = deps.agentSessionId(target.spaceId, target.agentId);
  if (
    sessionId !== null &&
    (await deps.getSession(sessionId)) !== null &&
    (await deps.isAgentTargetLifecycleEligible(target.spaceId, target.agentId))
  ) {
    return { kind: 'resolved', sessionId, created: false };
  }
  return { kind: 'unresolved', reason: 'not_found' };
}
