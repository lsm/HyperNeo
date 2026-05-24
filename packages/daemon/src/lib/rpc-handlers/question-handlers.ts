/**
 * Question RPC Handlers
 *
 * Handles user responses to AskUserQuestion tool calls.
 */

import type { MessageHub, QuestionDraftResponse } from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SessionManager } from '../session-manager';
import type { AgentSession } from '../agent/agent-session';

/**
 * Payload for question.respond RPC call
 */
interface QuestionRespondPayload {
  sessionId: string;
  toolUseId: string;
  responses: QuestionDraftResponse[];
}

/**
 * Payload for question.saveDraft RPC call
 */
interface QuestionSaveDraftPayload {
  sessionId: string;
  draftResponses: QuestionDraftResponse[];
}

/**
 * Payload for question.cancel RPC call
 */
interface QuestionCancelPayload {
  sessionId: string;
  toolUseId: string;
}

export function setupQuestionHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  /**
   * Optional lookup for room worker/leader sessions.
   *
   * Task agent sessions are managed by SpaceRuntimeService,
   * which maintains an in-memory map alongside SessionManager's cache. If SessionManager is
   * used alone it creates a fresh AgentSession from the DB (no live SDK query,
   * pendingResolver = null) and handleQuestionResponse always throws.
   *
   * Pass SpaceRuntimeService.getAgentSession.bind(runtimeService) here so the
   * handler resolves the correct live instance first.
   */
  getRuntimeSession?: (sessionId: string) => AgentSession | undefined
): void {
  /**
   * Resolve the AgentSession that owns the live SDK query for a given session ID.
   *
   * Prefers the runtime pool (worker/leader sessions) over SessionManager's cache
   * because SessionManager.getSessionAsync() loads a fresh instance from the DB
   * when the session is not in its own cache — that instance has no pendingResolver
   * and handleQuestionResponse would always throw "No pending question to respond to".
   */
  async function resolveSession(sessionId: string): Promise<AgentSession | null> {
    // Room worker/leader sessions: check runtime pool first
    const runtimeSession = getRuntimeSession?.(sessionId);
    if (runtimeSession) return runtimeSession;

    // Lobby/room-chat sessions: fall back to SessionManager
    return sessionManager.getSessionAsync(sessionId);
  }

  /**
   * question.respond - Send user's response to pending question
   *
   * This sends the user's selected options as a tool_result message
   * to continue the SDK query that was paused waiting for input.
   */
  messageHub.onRequest('question.respond', async (data) => {
    const { sessionId, toolUseId, responses } = data as QuestionRespondPayload;

    const agentSession = await resolveSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await agentSession.handleQuestionResponse(toolUseId, responses);
    return { success: true };
  });

  /**
   * question.saveDraft - Save draft responses as user interacts (before submit)
   *
   * This allows preserving the user's partial selections if they
   * navigate away or refresh the page before submitting.
   */
  messageHub.onRequest('question.saveDraft', async (data) => {
    const { sessionId, draftResponses } = data as QuestionSaveDraftPayload;

    const agentSession = await resolveSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await agentSession.updateQuestionDraft(draftResponses);
    return { success: true };
  });

  /**
   * question.cancel - Cancel the pending question without answering
   *
   * This allows the user to dismiss the question. The agent will receive
   * a message indicating the user cancelled, and can decide how to proceed.
   */
  messageHub.onRequest('question.cancel', async (data) => {
    const { sessionId, toolUseId } = data as QuestionCancelPayload;

    const agentSession = await resolveSession(sessionId);
    if (!agentSession) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await agentSession.handleQuestionCancel(toolUseId);
    return { success: true };
  });
}
