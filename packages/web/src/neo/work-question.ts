import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';

type Gate<T> = { value: T } | { reason: null };

export function requireNeoQuestionWork(
  work: NeoWork,
  activeSessionId: string | null,
  available: boolean
): Gate<NeoWork> {
  return available &&
    work.status === 'queued' &&
    !!work.id.trim() &&
    !!work.sessionId?.trim() &&
    work.sessionId === activeSessionId &&
    (!work.targetSessionId || work.targetSessionId === work.sessionId)
    ? { value: work }
    : { reason: null };
}

export function requireNeoPendingQuestion(
  work: NeoWork,
  state: SessionState | null
): Gate<PendingUserQuestion> {
  return state?.sessionInfo?.id === work.sessionId &&
    state.agentState.status === 'waiting_for_input'
    ? { value: state.agentState.pendingQuestion }
    : { reason: null };
}

export function requireNeoQuestionOrigin(
  question: PendingUserQuestion,
  work: NeoWork
): Gate<PendingUserQuestion> {
  return question.inputOrigin?.sessionId === work.sessionId &&
    question.inputOrigin.messageId === work.id &&
    !!question.toolUseId.trim()
    ? { value: question }
    : { reason: null };
}

export const projectNeoWorkQuestion = (superpipe({})('neo-work-question') as PipelineAPI)
  .input(['work', 'activeSessionId', 'available', 'state'])
  .pipe(requireNeoQuestionWork, ['work', 'activeSessionId', 'available'], 'result:question')
  .pipe(requireNeoPendingQuestion, ['question', 'state'], 'result:question')
  .pipe(requireNeoQuestionOrigin, ['question', 'work'], 'result:question')
  .end('question') as (
  work: NeoWork,
  activeSessionId: string | null,
  available: boolean,
  state: SessionState | null
) => PendingUserQuestion | null;
