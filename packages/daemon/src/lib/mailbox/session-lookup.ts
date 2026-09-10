import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';

export async function resolveMailboxSession(
  sessionId: string,
  sessionManager: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync'> | null,
  taskAgentManager: Pick<TaskAgentManager, 'getSubSession'> | null
) {
  const indexed = taskAgentManager?.getSubSession(sessionId);
  if (indexed && sessionManager?.getCachedSession(sessionId) === indexed) {
    const data = indexed.getSessionData();
    if (data.status === 'ended') return null;
    if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(data.config)) {
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
    !hasRuntimeNodeAgentServer(session.getSessionData().config)
  ) {
    return null;
  }
  return session;
}
