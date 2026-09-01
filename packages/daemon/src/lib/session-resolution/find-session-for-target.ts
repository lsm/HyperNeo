import type { SessionResolutionDeps } from './deps.ts';
import { agentSessionIdOf } from './target.ts';
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
  const sessionId = agentSessionIdOf(target.spaceId, target.agentId);
  if ((await deps.getSession(sessionId)) !== null) {
    return { kind: 'resolved', sessionId, created: false };
  }
  return { kind: 'unresolved', reason: 'not_found' };
}
