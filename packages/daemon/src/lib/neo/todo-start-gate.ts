import { livePlanSteps, NEO_PLAN_SIGNOFF, samePlanSteps } from './todo-follow-up.ts';
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
      todo.id === question.todoId && todo.askId === question.askId && todo.state !== 'removed'
  );
  if (question.todoId && !active) return { value: { retire: 'todo no longer active' } };
  if (
    question.cause === NEO_PLAN_SIGNOFF &&
    question.todoId &&
    !samePlanSteps(question.todos, livePlanSteps(question.todoId, family))
  )
    return { value: { retire: 'plan steps changed' } };
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
