import type { NeoTodo, NeoTodoEntry, NeoTodoPriority } from '@hyperneo/shared/types/neo-ask';
import type { OperationName } from '@hyperneo/shared/types/operation-names';

export type NeoTodoControl =
  | { kind: 'done' }
  | { kind: 'cancel' }
  | { kind: 'hold' }
  | { kind: 'priority'; priority: NeoTodoPriority };

export const NEO_TODO_PRIORITIES: readonly NeoTodoPriority[] = ['urgent', 'high', 'normal', 'low'];

export const neoTodoControllable = (todo: Pick<NeoTodo, 'state'>) =>
  ['todo', 'doing', 'blocked', 'failed'].includes(todo.state);

export const neoTodoHoldable = (
  todo: Pick<NeoTodoEntry, 'state' | 'blockedBy' | 'startedAt' | 'statusCodes'>
) =>
  !todo.statusCodes?.some((code) => ['todo.held', 'todo.paused'].includes(code.code)) &&
  (todo.startedAt === null
    ? todo.state === 'todo' || (todo.state === 'blocked' && todo.blockedBy === 'question')
    : todo.state === 'doing' ||
      (todo.state === 'blocked' && ['question', 'needs-human'].includes(todo.blockedBy ?? '')));

export function neoTodoControlCall(
  todo: Pick<NeoTodo, 'id' | 'startedAt'>,
  control: NeoTodoControl
): { name: OperationName; input: Record<string, string> } {
  const todoId = todo.id;
  if (control.kind === 'done')
    return { name: 'neo.todo.done', input: { todoId, reason: 'The human marked it done.' } };
  if (control.kind === 'cancel')
    return { name: 'neo.todo.remove', input: { todoId, reason: 'The human cancelled it.' } };
  if (control.kind === 'hold')
    return {
      name: 'neo.todo.hold',
      input: {
        todoId,
        reason: todo.startedAt === null ? 'The human put it on hold.' : 'The human paused it.',
      },
    };
  return { name: 'neo.todo.edit', input: { todoId, priority: control.priority } };
}
