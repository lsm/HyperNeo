import type { SessionResolutionDeps } from './deps.ts';
import type { EnsureSessionOutcome, SessionTargetAgent } from './target.ts';

export async function ensureLongTermAgentSession(
  target: SessionTargetAgent,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  const existing = deps.agentSessionId(target.spaceId, target.agentId);
  if (existing && (await deps.getSession(existing)) !== null) {
    return { kind: 'resolved', sessionId: existing, created: false };
  }
  if ((await deps.ensureLongTermAgent(target.spaceId, target.agentId)) === null) {
    return { kind: 'unresolved', reason: 'ensure_failed' };
  }
  const sessionId = deps.agentSessionId(target.spaceId, target.agentId);
  return sessionId
    ? { kind: 'resolved', sessionId, created: true }
    : { kind: 'unresolved', reason: 'ensure_failed' };
}
