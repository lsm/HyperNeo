import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { planNeoDaemonCardPrune } from './daemon-cards.ts';
import { NEO_REMOVED_PREREQUISITE } from './todo-removal.ts';
import {
  NEO_TODO_NOT_READY,
  NEO_TODO_PREREQUISITE_UNFINISHED,
  neoTodoCancelledDependencies,
  neoTodoDependenciesAfterApproval,
  neoTodoFinished,
  neoTodoReady,
} from './todo-dependencies.ts';

export const NEO_TODO_NOT_APPROVED = 'not_approved: the human has not approved this step.';

const NEO_TODO_QUESTION_OPEN =
  'question_open: an open question holds this step; the queue starts it after the answer.';

const neoTodoPrerequisitesOpen = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  todo.startedAt === null
    ? !neoTodoReady(family, todo.id)
    : neoTodoDependenciesAfterApproval(family, todo.id).some(
        (id) => !neoTodoFinished(family.find((other) => other.id === id))
      );

export const neoTodoPrerequisiteRefusal = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  neoTodoPrerequisitesOpen(todo, family) ? NEO_TODO_PREREQUISITE_UNFINISHED : null;

export function neoTodoWaitReason(
  todo: NeoTodo,
  family: readonly NeoTodo[],
  questions: readonly NeoQuestion[],
  trackerHold: string | null = null
): string | null {
  if (todo.blockedBy === 'held') return 'todo_held: the human is holding this todo.';
  if (neoTodoPrerequisitesOpen(todo, family)) return NEO_TODO_NOT_READY;
  return questions.some((question) => question.state === 'open' && question.todos.includes(todo.id))
    ? NEO_TODO_QUESTION_OPEN
    : trackerHold;
}

export const neoTodoStartRefusal = (
  todo: NeoTodo,
  family: readonly NeoTodo[],
  questions: readonly NeoQuestion[],
  trackerHold: string | null = null
): string | null =>
  todo.approvedAt === null
    ? NEO_TODO_NOT_APPROVED
    : neoTodoWaitReason(todo, family, questions, trackerHold);

export const neoTodoCancellationPending = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  todo.startedAt === null &&
  (todo.state === 'todo' ||
    (todo.state === 'blocked' && (todo.blockedBy === 'question' || todo.blockedBy === 'check'))) &&
  neoTodoCancelledDependencies(family, todo.id).length > 0;

const familyTodo = (family: readonly NeoTodo[], id: string | null) =>
  family.find((todo) => todo.id === id);

const replacedName = (family: readonly NeoTodo[], todo: NeoTodo) => {
  const replacement = familyTodo(family, todo.replacedBy);
  return replacement ? `"${todo.title}" (replaced by "${replacement.title}")` : null;
};

export function neoCancelledPrerequisiteNote(todo: NeoTodo, family: readonly NeoTodo[]): string {
  const names = neoTodoCancelledDependencies(family, todo.id).map(
    (gone) =>
      replacedName(family, gone) ??
      (gone.reason ? `"${gone.title}" (${gone.reason})` : `"${gone.title}"`)
  );
  return [
    `Prerequisite ${names.join(', ')} of todo "${todo.title}" (${todo.id}) was cancelled, so it will not start by itself.`,
    'neo.todo.remove stops it, and neo.question.ask is only for when you cannot tell what the human wants.',
  ].join(' ');
}

export const neoCancelledPrerequisiteKey = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  `neo-todo-prereq:${todo.id}:${neoTodoCancelledDependencies(family, todo.id)
    .map(({ id }) => id)
    .join(',')}`;

export type NeoQuestionPrune =
  | { retire: string }
  | {
      retire?: undefined;
      kept: string[];
      text: string;
      state: NeoQuestion['state'];
      retiredReason: string | null;
      released: NeoTodo[];
    };

export function planNeoQuestionPrune(
  question: NeoQuestion,
  family: readonly NeoTodo[]
): { value: NeoQuestionPrune } | { reason: 'unchanged' } {
  const active = family.some(
    (todo) =>
      todo.id === question.todoId &&
      todo.askId === question.askId &&
      !['done', 'removed'].includes(todo.state)
  );
  if (question.todoId && !active) return { value: { retire: 'todo no longer active' } };
  if (
    question.cause === NEO_REMOVED_PREREQUISITE &&
    !family.some(
      (todo) =>
        question.todos.includes(todo.id) &&
        todo.startedAt === null &&
        !['done', 'removed'].includes(todo.state)
    )
  )
    return { value: { retire: 'nothing left to decide' } };
  const daemonCard = planNeoDaemonCardPrune(question, family);
  if (daemonCard) return { value: daemonCard };
  return { reason: 'unchanged' };
}

export const neoTodosAwaitingNeoDecision = (
  family: readonly NeoTodo[],
  ask: NeoAsk | null,
  questions: readonly NeoQuestion[]
) =>
  family.filter(
    (todo) =>
      ask?.status === 'open' &&
      todo.askId === ask.id &&
      neoTodoCancellationPending(todo, family) &&
      !questions.some(
        (q) =>
          q.state === 'open' && q.cause === NEO_REMOVED_PREREQUISITE && q.todos.includes(todo.id)
      )
  );
