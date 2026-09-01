import type { SessionResolutionDeps } from './deps.ts';
import { agentSessionIdOf, type EnsureSessionOutcome, type SessionTargetAgent } from './target.ts';

export async function ensureAgentSession(
  target: SessionTargetAgent,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const coordinator = await deps.getCoordinator(target.spaceId);
  const sessionId = agentSessionIdOf(target.spaceId, target.agentId, coordinator?.id);
  if ((await deps.getSession(sessionId)) !== null) {
    return { kind: 'resolved', sessionId, created: false };
  }
  if ((await deps.ensureLongTermAgent(target.spaceId, target.agentId)) === null) {
    return { kind: 'unresolved', reason: 'ensure_failed' };
  }
  return { kind: 'resolved', sessionId, created: true };
}
