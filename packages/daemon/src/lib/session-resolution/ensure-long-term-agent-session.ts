import type { SessionResolutionDeps } from './deps.ts';
import type { EnsureSessionOutcome, SessionTargetAgent } from './target.ts';

export async function ensureLongTermAgentSession(
  target: SessionTargetAgent,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const sessionId = deps.agentSessionId(target.spaceId, target.agentId);
  if ((await deps.getSession(sessionId)) !== null) {
    return { kind: 'resolved', sessionId, created: false };
  }
  if ((await deps.ensureLongTermAgent(target.spaceId, target.agentId)) === null) {
    return { kind: 'unresolved', reason: 'ensure_failed' };
  }
  return { kind: 'resolved', sessionId, created: true };
}
