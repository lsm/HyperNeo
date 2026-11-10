import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import { neoDerivedId } from './derived-id.ts';
import { neoQuestionCoversTodo } from './todo-state.ts';

export function neoNoticeCardIds(todo: Pick<NeoTodo, 'id'>, questions: readonly NeoQuestion[]) {
  return questions
    .filter(
      (question) =>
        neoQuestionCoversTodo(question, todo) &&
        (question.todoId === todo.id || question.kind === 'start')
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
  cardIds: readonly string[] = [],
  blockerState?: string
) {
  const blocker = turn.message.match(
    /^Blocked \((needs_human|environment)\): ([^\r\n]+)(?:\r?\n)?$/
  );
  const kind = blocker?.[1] === 'needs_human' ? 'needs-human' : 'environment';
  const focused = ask.focusedSession;
  if (
    !blocker ||
    turn.humanInput !== undefined ||
    turn.notice ||
    todo.state !== 'blocked' ||
    todo.blockedBy !== kind ||
    todo.blockedReason !== blocker[2].trim() ||
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
        blockerState,
        cardIds,
      ])
    ),
    covered: cardIds.length > 0,
  };
}
