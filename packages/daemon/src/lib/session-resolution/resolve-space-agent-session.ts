import { coordinatorSessionId } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SessionResolutionDeps } from './deps.ts';
import { ensureSession } from './ensure-session.ts';

export async function resolveSpaceAgentSession<Session>(
  spaceId: string,
  replyToSessionId: string | null | undefined,
  deps: SessionResolutionDeps,
  getSession: (sessionId: string) => Promise<Session | null>
): Promise<{ sessionId: string; session: Session }> {
  const coordinatorTarget = { kind: 'agent' as const, spaceId, agentId: 'coordinator' };
  let outcome = await ensureSession(
    replyToSessionId === null || replyToSessionId === undefined
      ? coordinatorTarget
      : { kind: 'session', sessionId: replyToSessionId },
    deps
  );
  if (
    outcome.kind === 'unresolved' &&
    replyToSessionId !== null &&
    replyToSessionId !== undefined
  ) {
    outcome = await ensureSession(coordinatorTarget, deps);
  }
  if (outcome.kind === 'unresolved') {
    throw new Error(
      `Session not found for Space Agent reply routing: ${coordinatorSessionId(spaceId)}`
    );
  }
  const session = await getSession(outcome.sessionId);
  if (session === null) {
    throw new Error(`Session not found for Space Agent reply routing: ${outcome.sessionId}`);
  }
  return { sessionId: outcome.sessionId, session };
}
