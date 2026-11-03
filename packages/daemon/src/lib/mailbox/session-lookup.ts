import {
  hasRuntimeWorkerOperations,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { AgentSession } from '../agent/agent-session.ts';

export async function resolveMailboxSession(
  sessionId: string,
  sessionManager: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync'> | null,
  taskAgentManager: { getSubSession(sessionId: string): AgentSession | undefined } | null
) {
  const indexed = taskAgentManager?.getSubSession(sessionId);
  if (indexed && sessionManager?.getCachedSession(sessionId) === indexed) {
    const data = indexed.getSessionData();
    if (data.status === 'ended') return null;
    if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeWorkerOperations(data.config)) {
      return null;
    }
    return indexed;
  }
  const session = (await sessionManager?.getSessionAsync(sessionId)) ?? null;
  if (session && session.getSessionData().status === 'ended') {
    return null;
  }
  if (
    session &&
    isWorkflowSubSessionIdentity(sessionId) &&
    !hasRuntimeWorkerOperations(session.getSessionData().config)
  ) {
    return null;
  }
  return session;
}
