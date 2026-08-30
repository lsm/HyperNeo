import type { MessageHub, QuestionDraftResponse } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';
import type { AgentSession } from '../agent/agent-session.ts';

interface QuestionRespondPayload {
  sessionId: string;
  toolUseId: string;
  responses: QuestionDraftResponse[];
}

interface QuestionSaveDraftPayload {
  sessionId: string;
  draftResponses: QuestionDraftResponse[];
}

interface QuestionCancelPayload {
  sessionId: string;
  toolUseId: string;
}

export function setupQuestionHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  getRuntimeSession?: (sessionId: string) => AgentSession | undefined
): void {
  async function resolveSession(sessionId: string): Promise<AgentSession | null> {
    const runtimeSession = getRuntimeSession?.(sessionId);
    if (runtimeSession) return runtimeSession;

    return sessionManager.getSessionAsync(sessionId);
  }

  function assertWorkflowProvisioned(agentSession: AgentSession, sessionId: string): void {
    const data = agentSession.getSessionData();
    if (isWorkflowSubSessionIdentity(data.id) && !hasRuntimeNodeAgentServer(data.config)) {
      throw new Error(`Workflow session ${sessionId} is not resumable — provisioning skipped`);
    }
  }

  messageHub.onRequest('question.respond', async (data) => {
    const { sessionId, toolUseId, responses } = data as QuestionRespondPayload;

    const agentSession = await resolveSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    assertWorkflowProvisioned(agentSession, sessionId);

    await agentSession.handleQuestionResponse(toolUseId, responses);
    return { success: true };
  });

  messageHub.onRequest('question.saveDraft', async (data) => {
    const { sessionId, draftResponses } = data as QuestionSaveDraftPayload;

    const agentSession =
      getRuntimeSession?.(sessionId) ?? (await sessionManager.getSessionForControl(sessionId));
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await agentSession.updateQuestionDraft(draftResponses);
    return { success: true };
  });

  messageHub.onRequest('question.cancel', async (data) => {
    const { sessionId, toolUseId } = data as QuestionCancelPayload;

    const agentSession = await resolveSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    assertWorkflowProvisioned(agentSession, sessionId);

    await agentSession.handleQuestionCancel(toolUseId);
    return { success: true };
  });
}
