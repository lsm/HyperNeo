import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NEO_TODO_NOT_READY, neoTodoReady } from './todo-dependencies.ts';

export const NEO_TODO_NOT_APPROVED =
  'not_approved: the human has not approved this step; it waits on its Start card.';

const NEO_TODO_QUESTION_OPEN =
  'question_open: an open question holds this step; the queue starts it after the answer.';

export function neoTodoWaitReason(
  todo: NeoTodo,
  family: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): string | null {
  if (todo.blockedBy === 'held') return 'todo_held: the human is holding this todo.';
  if (!neoTodoReady(family, todo.id)) return NEO_TODO_NOT_READY;
  return questions.some(
    (question) =>
      question.state === 'open' &&
      question.kind !== 'start' &&
      (!question.todoId || question.todoId === todo.id)
  )
    ? NEO_TODO_QUESTION_OPEN
    : null;
}

export const neoTodoStartRefusal = (
  todo: NeoTodo,
  family: readonly NeoTodo[],
  questions: readonly NeoQuestion[]
): string | null =>
  todo.approvedAt === null ? NEO_TODO_NOT_APPROVED : neoTodoWaitReason(todo, family, questions);

export const neoTodoAwaitsApproval = (todo: NeoTodo) =>
  todo.approvedAt === null &&
  (todo.state === 'todo' || (todo.state === 'blocked' && todo.blockedBy === 'question'));

export function planNeoStartAnswer(
  todo: NeoTodo,
  ticked: readonly string[] | undefined,
  heldReason: string,
  now: number
): NeoTodoPatch | null {
  if (todo.state !== 'blocked' || todo.blockedBy !== 'question')
    return ticked?.includes(todo.id) ? { approvedAt: now } : null;
  return ticked && !ticked.includes(todo.id)
    ? {
        state: 'blocked',
        blockedBy: 'held',
        blockedReason: heldReason,
        nextAction: 'The human releases it.',
      }
    : { state: 'todo', approvedAt: todo.approvedAt ?? now };
}
