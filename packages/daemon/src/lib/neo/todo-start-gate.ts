import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoStartQuestionTitle } from './start-question.ts';
import {
  NEO_TODO_NOT_READY,
  NEO_TODO_PREREQUISITE_UNFINISHED,
  neoTodoCancelledDependencies,
  neoTodoDependenciesAfterApproval,
  neoTodoFinished,
  neoTodoReady,
} from './todo-dependencies.ts';

export const NEO_TODO_NOT_APPROVED =
  'not_approved: the human has not approved this step; it waits on its Start card.';

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
  questions: readonly NeoQuestion[]
): string | null {
  if (todo.blockedBy === 'held') return 'todo_held: the human is holding this todo.';
  if (neoTodoPrerequisitesOpen(todo, family)) return NEO_TODO_NOT_READY;
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

export const neoTodoCancellationPending = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  todo.startedAt === null &&
  (todo.state === 'todo' ||
    (todo.state === 'blocked' && (todo.blockedBy === 'question' || todo.blockedBy === 'check'))) &&
  neoTodoCancelledDependencies(family, todo.id).length > 0;

export const neoTodoOnStartCard = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  neoTodoAwaitsApproval(todo) || neoTodoCancellationPending(todo, family);

const quoted = (todos: readonly NeoTodo[]) => todos.map((todo) => `"${todo.title}"`).join(', ');

const familyTodo = (family: readonly NeoTodo[], id: string | null) =>
  family.find((todo) => todo.id === id);

const replacedName = (family: readonly NeoTodo[], todo: NeoTodo) => {
  const replacement = familyTodo(family, todo.replacedBy);
  return replacement ? `"${todo.title}" (replaced by "${replacement.title}")` : null;
};

const waitLine = (family: readonly NeoTodo[], id: string) => {
  const waiting = neoTodoDependenciesAfterApproval(family, id)
    .map((other) => familyTodo(family, other))
    .filter((todo): todo is NeoTodo => !!todo && !neoTodoFinished(todo));
  return waiting.length ? [`It will wait for ${quoted(waiting)}.`] : [];
};

function cancellationLine(family: readonly NeoTodo[], id: string): string[] {
  const cancelled = neoTodoCancelledDependencies(family, id);
  if (!cancelled.length) return [];
  const names = cancelled.map((todo) => replacedName(family, todo) ?? `"${todo.title}"`);
  return [
    [
      `Prerequisite ${names.join(', ')} was cancelled. Go ahead with "${familyTodo(family, id)?.title}" anyway?`,
      ...waitLine(family, id),
      'Select it to continue; leave it unticked to remove it.',
    ].join(' '),
  ];
}

export function neoCancelledPrerequisiteNote(todo: NeoTodo, family: readonly NeoTodo[]): string {
  const names = neoTodoCancelledDependencies(family, todo.id).map(
    (gone) =>
      replacedName(family, gone) ??
      (gone.reason ? `"${gone.title}" (${gone.reason})` : `"${gone.title}"`)
  );
  return [
    `Prerequisite ${names.join(', ')} of todo "${todo.title}" (${todo.id}) was cancelled, so it will not start by itself.`,
    'neo.todo.proceed continues it,',
    ...waitLine(family, todo.id),
    'neo.todo.remove stops it, and neo.question.ask is only for when you cannot tell what the human wants.',
  ].join(' ');
}

export const neoCancelledPrerequisiteKey = (todo: NeoTodo, family: readonly NeoTodo[]) =>
  `neo-todo-prereq:${todo.id}:${neoTodoCancelledDependencies(family, todo.id)
    .map(({ id }) => id)
    .join(',')}`;

export const neoTodoProceedPatch = (
  todo: NeoTodo,
  family: readonly NeoTodo[],
  now: number
): NeoTodoPatch => ({
  state: 'todo',
  approvedAt: todo.approvedAt ?? now,
  dependsOn: neoTodoDependenciesAfterApproval(family, todo.id),
});

export const neoStartCardText = (ids: readonly string[], family: readonly NeoTodo[]) =>
  [
    neoStartQuestionTitle(ids.map((id) => family.find((todo) => todo.id === id) ?? {})),
    ...ids.flatMap((id) => cancellationLine(family, id)),
  ].join('\n');

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
  if (question.kind !== 'start' || !question.startTodos) return { reason: 'unchanged' };
  const listed = question.startTodos;
  const kept = listed.filter((id) => {
    const todo = family.find((item) => item.id === id);
    return todo?.askId === question.askId && neoTodoOnStartCard(todo, family);
  });
  const text = neoStartCardText(kept, family);
  const same =
    kept.length === listed.length &&
    (text === question.text || !kept.some((id) => neoTodoCancelledDependencies(family, id).length));
  if (same) return { reason: 'unchanged' };
  return {
    value: {
      kept,
      text: kept.length ? text : question.text,
      state: kept.length ? 'open' : 'retired',
      retiredReason: kept.length ? null : 'nothing left to start',
      released: family.filter(
        (todo) =>
          listed.includes(todo.id) &&
          !kept.includes(todo.id) &&
          !!todo.approvedAt &&
          todo.blockedBy === 'question'
      ),
    },
  };
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
      ? neoTodoProceedPatch(todo, family, now)
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

export function planNeoStartRelease(
  question: NeoQuestion,
  family: readonly NeoTodo[],
  questions: readonly NeoQuestion[],
  ticked: readonly string[] | undefined,
  withdrawn: string | undefined,
  now: number
) {
  const waiting = questions
    .filter((other) => other.kind === 'start' && other.state === 'open')
    .flatMap((other) => other.startTodos ?? []);
  const writes: { todo: NeoTodo; patch: NeoTodoPatch }[] = [];
  let current = family;
  for (const id of question.startTodos ?? []) {
    const todo = current.find((item) => item.id === id);
    const patch =
      todo && !waiting.includes(id)
        ? planNeoStartAnswer(todo, current, ticked, withdrawn, now)
        : null;
    if (!todo || !patch) continue;
    writes.push({ todo, patch });
    current = current.map((item) => (item.id === id ? { ...item, ...patch } : item));
  }
  return writes;
}
