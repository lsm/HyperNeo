import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoStartQuestionTitle } from './start-question.ts';
import {
  NEO_TODO_NOT_READY,
  neoTodoCancelledDependencies,
  neoTodoDependenciesAfterApproval,
  neoTodoFinished,
  neoTodoReady,
} from './todo-dependencies.ts';

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

const neoTodoCancellationPending = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  todo.startedAt === null &&
  (todo.state === 'todo' ||
    (todo.state === 'blocked' && (todo.blockedBy === 'question' || todo.blockedBy === 'check'))) &&
  neoTodoCancelledDependencies(family, todo.id).length > 0;

export const neoTodoOnStartCard = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  neoTodoAwaitsApproval(todo) || neoTodoCancellationPending(todo, family);

const quoted = (todos: readonly NeoTodo[]) => todos.map((todo) => `"${todo.title}"`).join(', ');

function cancellationLine(family: readonly NeoTodo[], id: string): string[] {
  const cancelled = neoTodoCancelledDependencies(family, id);
  if (!cancelled.length) return [];
  const find = (other: string | null) => family.find((todo) => todo.id === other);
  const waiting = neoTodoDependenciesAfterApproval(family, id)
    .map(find)
    .filter((todo): todo is NeoTodo => !!todo && !neoTodoFinished(todo));
  const names = cancelled.map((todo) => {
    const replacement = find(todo.replacedBy);
    return replacement ? `"${todo.title}" (replaced by "${replacement.title}")` : `"${todo.title}"`;
  });
  return [
    [
      `Prerequisite ${names.join(', ')} was cancelled. Go ahead with "${find(id)?.title}" anyway?`,
      ...(waiting.length ? [`It will wait for ${quoted(waiting)}.`] : []),
      'Select it to continue; leave it unticked to remove it.',
    ].join(' '),
  ];
}

export const neoStartCardText = (ids: readonly string[], family: readonly NeoTodo[]) =>
  [
    neoStartQuestionTitle(ids.map((id) => family.find((todo) => todo.id === id) ?? {})),
    ...ids.flatMap((id) => cancellationLine(family, id)),
  ].join('\n');

export function planNeoStartCardPrune(question: NeoQuestion, family: readonly NeoTodo[]) {
  const listed = question.startTodos ?? [];
  const kept = listed.filter((id) => {
    const todo = family.find((item) => item.id === id);
    return todo?.askId === question.askId && neoTodoOnStartCard(todo, family);
  });
  const text = neoStartCardText(kept, family);
  const same =
    kept.length === listed.length &&
    (text === question.text || !kept.some((id) => neoTodoCancelledDependencies(family, id).length));
  return same ? null : { kept, text, dropped: listed.filter((id) => !kept.includes(id)) };
}

export const neoTodosAwaitingCancellationCard = (
  family: readonly NeoTodo[],
  askId: string,
  questions: readonly NeoQuestion[]
) =>
  family.filter(
    (todo) =>
      todo.askId === askId &&
      neoTodoCancellationPending(todo, family) &&
      !questions.some((q) => q.state === 'open' && q.startTodos?.includes(todo.id))
  );

export function planNeoStartAnswer(
  todo: NeoTodo,
  family: readonly NeoTodo[],
  ticked: readonly string[] | undefined,
  withdrawn: string | undefined,
  now: number
): NeoTodoPatch | null {
  const cancelled = neoTodoCancellationPending(todo, family);
  if (!cancelled && (todo.state !== 'blocked' || todo.blockedBy !== 'question'))
    return ticked?.includes(todo.id) ? { approvedAt: now } : null;
  if (cancelled) {
    if (withdrawn) return null;
    return ticked?.includes(todo.id)
      ? {
          state: 'todo',
          approvedAt: todo.approvedAt ?? now,
          dependsOn: neoTodoDependenciesAfterApproval(family, todo.id),
        }
      : {
          state: 'removed',
          reason: 'The human declined after a prerequisite was cancelled.',
          finishedAt: now,
        };
  }
  return ticked && !ticked.includes(todo.id)
    ? {
        state: 'blocked',
        blockedBy: 'held',
        blockedReason: withdrawn ?? 'Not ticked in the start answer.',
        nextAction: 'The human releases it.',
      }
    : { state: 'todo', approvedAt: todo.approvedAt ?? now };
}
