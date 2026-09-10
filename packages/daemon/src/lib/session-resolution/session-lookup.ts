import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { TaskAgentManager } from '../space/runtime/task-agent-manager.ts';

export const sessionUnavailable = (status: string): boolean =>
  status === 'ended' || status === 'archived';

export async function resolveLiveSession(
  sessionId: string,
  sessionManager: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync'>,
  taskAgentManager?: Pick<TaskAgentManager, 'getSubSession'>
): Promise<unknown | null> {
  const indexed = taskAgentManager?.getSubSession(sessionId);
  if (indexed !== undefined && sessionManager.getCachedSession(sessionId) === indexed) {
    const data = indexed.getSessionData();
    if (sessionUnavailable(data.status)) return null;
    if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(data.config)) {
      return null;
    }
    return indexed;
  }
  const session = await sessionManager.getSessionAsync(sessionId);
  if (session === null || sessionUnavailable(session.getSessionData().status)) return null;
  if (
    isWorkflowSubSessionIdentity(sessionId) &&
    !hasRuntimeNodeAgentServer(session.getSessionData().config)
  ) {
    return null;
  }
  return session;
}
