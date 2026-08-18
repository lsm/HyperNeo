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
}

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

    const unsub = onEvent<SessionState>('state.session', (event, context) => {
      if (cancelled) return;
      if (context.channel !== channel) return;
      applySessionState(event, setPendingQuestion, setResolvedQuestions);
    });

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
