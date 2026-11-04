import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoStartQuestionTitle } from './start-question.ts';
import {
  neoTodoCancelledDependencies,
  neoTodoDependencyNodes,
  neoTodoFinished,
  neoTodoRemainingDependencies,
} from './todo-dependencies.ts';

export type NeoStartCardOutcome = { ticked: readonly string[] } | { withdrawn: string };

export const neoTodoStartable = (todo: NeoTodo) =>
  todo.state === 'todo' || (todo.state === 'blocked' && todo.blockedBy === 'question');

export function neoStartCardTodos(family: readonly NeoTodo[], askId: string): Set<string> {
  const independent = new Set(
    neoTodoDependencyNodes(family)
      .filter((node) => !node.dependsOn?.length)
      .map((node) => node.id)
  );
  return new Set(
    family
      .filter(
        (todo) =>
          todo.askId === askId &&
          neoTodoStartable(todo) &&
          (independent.has(todo.id) ||
            (todo.startedAt === null && neoTodoCancelledDependencies(family, todo.id).length > 0))
      )
      .map((todo) => todo.id)
  );
}

const quoted = (todos: readonly NeoTodo[]) => todos.map((todo) => `"${todo.title}"`).join(', ');

function cancellationLine(family: readonly NeoTodo[], id: string): string[] {
  const cancelled = neoTodoCancelledDependencies(family, id);
  if (!cancelled.length) return [];
  const find = (other: string | null) => family.find((todo) => todo.id === other);
  const remaining = neoTodoRemainingDependencies(family, id);
  const waiting = remaining.map(find).filter((todo) => todo && !neoTodoFinished(todo)) as NeoTodo[];
  const skipped = cancelled
    .map((todo) => find(todo.replacedBy))
    .filter((todo) => todo && !remaining.includes(todo.id)) as NeoTodo[];
  const names = cancelled.map((todo) => {
    const replacement = find(todo.replacedBy);
    return replacement ? `"${todo.title}" (replaced by "${replacement.title}")` : `"${todo.title}"`;
  });
  return [
    [
      `Prerequisite ${names.join(', ')} was cancelled. Go ahead with "${find(id)?.title}" anyway?`,
      ...(waiting.length ? [`It still waits for ${quoted(waiting)}.`] : []),
      ...(skipped.length ? [`It will not wait for ${quoted(skipped)}.`] : []),
      'Select it to continue; leave it unticked to remove it.',
    ].join(' '),
  ];
}

export function neoStartCardText(ids: readonly string[], family: readonly NeoTodo[]): string {
  return [
    neoStartQuestionTitle(ids.map((id) => family.find((todo) => todo.id === id) ?? {})),
    ...ids.flatMap((id) => cancellationLine(family, id)),
  ].join('\n');
}

export function planNeoStartCardPrune(
  question: NeoQuestion,
  startable: ReadonlySet<string>,
  family: readonly NeoTodo[]
): { kept: string[]; text: string; released: string[] } | null {
  const listed = question.startTodos ?? [];
  const kept = listed.filter((id) => startable.has(id));
  const text = neoStartCardText(kept, family);
  const unchanged =
    kept.length === listed.length &&
    (text === question.text || !kept.some((id) => neoTodoCancelledDependencies(family, id).length));
  return unchanged ? null : { kept, text, released: listed.filter((id) => !kept.includes(id)) };
}

export function neoTodosAwaitingCancellationCard(
  family: readonly NeoTodo[],
  askId: string,
  questions: readonly NeoQuestion[]
): NeoTodo[] {
  const startable = neoStartCardTodos(family, askId);
  return family.filter(
    (todo) =>
      startable.has(todo.id) &&
      neoTodoCancelledDependencies(family, todo.id).length > 0 &&
      !questions.some((q) => q.state === 'open' && q.startTodos?.includes(todo.id))
  );
}

export function planNeoStartCardRelease(
  todo: NeoTodo,
  family: readonly NeoTodo[],
  outcome: NeoStartCardOutcome,
  now: number
): NeoTodoPatch | null {
  if (neoTodoCancelledDependencies(family, todo.id).length) {
    if ('withdrawn' in outcome) return null;
    return outcome.ticked.includes(todo.id)
      ? { state: 'todo', dependsOn: neoTodoRemainingDependencies(family, todo.id) }
      : {
          state: 'removed',
          reason: 'The human declined after a prerequisite was cancelled.',
          finishedAt: now,
        };
  }
  const unticked = 'withdrawn' in outcome ? outcome.withdrawn : 'Not ticked in the start answer.';
  return 'ticked' in outcome && outcome.ticked.includes(todo.id)
    ? { state: 'todo' }
    : {
        state: 'blocked',
        blockedBy: 'held',
        blockedReason: unticked,
        nextAction: 'The human releases it.',
      };
}
