/**
 * useSessionQuestionState Hook
 *
 * Subscribes to a session's state channel and tracks question state
 * (pending question and resolved questions). Used by TaskConversationRenderer
 * to pass the correct question state to SDKMessageRenderer for each agent session
 * in a task group, so that AskUserQuestion tool calls render as interactive forms.
 */

import { useCallback, useEffect, useState } from 'preact/hooks';
import type {
  PendingUserQuestion,
  QuestionDraftResponse,
  ResolvedQuestion,
  SessionState,
} from '@hyperneo/shared';
import { useMessageHub } from './useMessageHub';

export interface SessionQuestionState {
  pendingQuestion: PendingUserQuestion | null;
  resolvedQuestions: Map<string, ResolvedQuestion>;
  onQuestionResolved: (
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[]
  ) => void;
}

/**
 * Extracts pending question and resolved questions from a SessionState snapshot.
 * Shared between the real-time event handler and the initial fetch to avoid duplication.
 */
function applySessionState(
  sessionState: SessionState,
  setPendingQuestion: (q: PendingUserQuestion | null) => void,
  setResolvedQuestions: (map: Map<string, ResolvedQuestion>) => void
): void {
  if (sessionState.agentState.status === 'waiting_for_input') {
    setPendingQuestion(sessionState.agentState.pendingQuestion);
  } else {
    setPendingQuestion(null);
  }

  const resolvedRaw = sessionState.sessionInfo?.metadata?.resolvedQuestions;
  if (resolvedRaw) {
    const map = new Map<string, ResolvedQuestion>();
    for (const [toolUseId, resolved] of Object.entries(resolvedRaw)) {
      map.set(toolUseId, resolved as ResolvedQuestion);
    }
    setResolvedQuestions(map);
  }
  // When resolvedRaw is absent (e.g. sessionInfo: null), we intentionally do NOT
  // call setResolvedQuestions. Resolved questions are append-only: once a question
  // has been resolved it should remain visible, and optimistic updates from
  // onQuestionResolved must not be erased by a subsequent server event that lacks
  // metadata. The server will include resolvedQuestions in metadata once it
  // persists the resolution, at which point we will apply the authoritative map.
}

/**
 * Subscribes to session:{sessionId} channel and tracks question state.
 * Returns pendingQuestion, resolvedQuestions, and onQuestionResolved callback.
 * When sessionId is undefined, returns empty/no-op state.
 */
export function useSessionQuestionState(sessionId: string | undefined): SessionQuestionState {
  const { request, joinRoom, leaveRoom, onEvent } = useMessageHub();

  const [pendingQuestion, setPendingQuestion] = useState<PendingUserQuestion | null>(null);
  const [resolvedQuestions, setResolvedQuestions] = useState<Map<string, ResolvedQuestion>>(
    new Map()
  );

  useEffect(() => {
    if (!sessionId) {
      setPendingQuestion(null);
      setResolvedQuestions(new Map());
      return;
    }

    const channel = `session:${sessionId}`;
    joinRoom(channel);
    let cancelled = false;

    // Subscribe to state.session events for real-time updates.
    // Filter by context.channel to avoid cross-session contamination: both the
    // leader and worker hooks subscribe to the same 'state.session' method name,
    // but only process events that originated from their own session's channel.
    const unsub = onEvent<SessionState>('state.session', (event, context) => {
      if (cancelled) return;
      if (context.channel !== channel) return;
      applySessionState(event, setPendingQuestion, setResolvedQuestions);
    });

    // Fetch initial state — state.session RPC returns SessionState directly
    const fetchInitial = async () => {
      try {
        const sessionState = await request<SessionState>('state.session', { sessionId });
        if (!cancelled && sessionState) {
          applySessionState(sessionState, setPendingQuestion, setResolvedQuestions);
        }
      } catch {
        // Fetch failure is non-fatal — question state will be empty until next event
      }
    };

    void fetchInitial();

    return () => {
      cancelled = true;
      unsub();
      leaveRoom(channel);
    };
  }, [sessionId, joinRoom, leaveRoom, onEvent, request]);

  // Optimistic update: move question to resolved state locally for immediate UI feedback
  // (The actual RPC calls are handled by QuestionPrompt)
  const onQuestionResolved = useCallback(
    (resolvedState: 'submitted' | 'cancelled', responses: QuestionDraftResponse[]) => {
      if (!pendingQuestion) return;
      const resolved: ResolvedQuestion = {
        question: pendingQuestion,
        state: resolvedState,
        responses,
        resolvedAt: Date.now(),
      };
      setResolvedQuestions((prev) => {
        const next = new Map(prev);
        next.set(pendingQuestion.toolUseId, resolved);
        return next;
      });
      setPendingQuestion(null);
    },
    [pendingQuestion]
  );

  return { pendingQuestion, resolvedQuestions, onQuestionResolved };
}
