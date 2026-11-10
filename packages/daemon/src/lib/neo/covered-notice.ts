import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import { neoDerivedId } from './derived-id.ts';

export function neoNoticeCardIds(
  todo: Pick<NeoTodo, 'id' | 'state' | 'blockedBy' | 'blockedReason'>,
  questions: readonly NeoQuestion[],
  ref: WorkRef
) {
  return questions
    .filter(
      (question) =>
        todo.state === 'blocked' &&
        todo.blockedBy === 'needs-human' &&
        question.state === 'open' &&
        question.kind !== 'start' &&
        question.todoId === todo.id &&
        question.text === todo.blockedReason &&
        question.sourceSession?.adapter === ref.adapter &&
        question.sourceSession.id === ref.id &&
        question.sourceSession.daemon === ref.daemon
    )
    .map((question) => question.id)
    .sort();
}

export const skipCoveredNeoNotice = (delivered: boolean, cardOpen: boolean) =>
  delivered && cardOpen;

export function neoBlockerNotice(
  ask: NeoAsk,
  todo: NeoTodo,
  dispatchId: string,
  ref: WorkRef,
  turn: { message: string; humanInput?: string; notice?: boolean },
  status: string | undefined,
  cardIds: readonly string[] = []
) {
  const blocker = turn.message.match(/^Blocked \(needs_human\): ([^\r\n]+)(?:\r?\n)?$/);
  const focused = ask.focusedSession;
  if (
    !blocker ||
    turn.humanInput !== undefined ||
    turn.notice ||
    todo.state !== 'blocked' ||
    todo.blockedBy !== 'needs-human' ||
    todo.blockedReason !== blocker[1].trim() ||
    (focused?.adapter === ref.adapter && focused.id === ref.id && focused.daemon === ref.daemon)
  )
    return null;
  return {
    key: neoDerivedId(
      JSON.stringify([
        'neo-blocker-notice',
        ask.sessionId,
        ask.id,
        todo.id,
        dispatchId,
        ref,
        status,
        todo.blockedBy,
        todo.blockedReason,
        todo.nextAction,
        cardIds,
      ])
    ),
    covered: cardIds.length > 0,
  };
}
