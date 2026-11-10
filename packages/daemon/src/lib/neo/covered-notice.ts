import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../drivers/types.ts';
import { neoDerivedId } from './derived-id.ts';

export const skipRepeatedNeoNotice = (delivered: boolean) => delivered;

export function neoBlockerNotice(
  ask: NeoAsk,
  todo: NeoTodo,
  dispatchId: string,
  ref: WorkRef,
  turn: { message: string; humanInput?: string; notice?: boolean },
  status: string | undefined,
  episode?: number | null
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
        episode ?? dispatchId,
        ref,
        status,
        todo.blockedBy,
        todo.blockedReason,
        todo.nextAction,
      ])
    ),
  };
}
