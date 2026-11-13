import type { NeoQuestion, NeoQuestionAnswer, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoPatch } from '../../storage/repositories/neo-ask-todo-repository.ts';
import {
  type NeoTodoEdge,
  neoTodoCancelledDependencies,
  neoTodoDependencyNodes,
  planNeoTodoDependencies,
} from './todo-dependencies.ts';

export const NEO_REMOVED_PREREQUISITE = 'removed_prerequisite';
export const NEO_REMOVED_PREREQUISITE_OPTIONS = ['Continue', 'Remove these'];

type Card = Pick<NeoQuestion, 'state' | 'kind' | 'todos' | 'cause'>;
type Row = NeoTodoEdge & Pick<NeoTodo, 'title'>;
type Write<T> = { todo: T; patch: NeoTodoPatch };
type CardPlan<C> = { askId: string; replaces: C | null; todos: string[]; text: string };

const live = (todo: Row) => !['done', 'closed_unverified', 'removed'].includes(todo.state);

const prerequisites = (family: readonly Row[], id: string) =>
  neoTodoDependencyNodes(family).find((node) => node.id === id)?.dependsOn ?? [];

function replacement(family: readonly Row[], gone: Row, dependent: string): string[] {
  const seen = new Set<string>();
  let next = family.find((todo) => todo.id === gone.replacedBy);
  while (next?.state === 'removed' && !seen.has(next.id)) {
    seen.add(next.id);
    const id = next.replacedBy;
    next = family.find((todo) => todo.id === id);
  }
  return next &&
    next.state !== 'removed' &&
    typeof planNeoTodoDependencies(family, dependent, [next.id]) !== 'string'
    ? [next.id]
    : [];
}

const without = (family: readonly Row[], dependent: Row, gone: readonly Row[]) => [
  ...new Set(
    prerequisites(family, dependent.id).flatMap((id) => {
      const removed = gone.find((todo) => todo.id === id);
      return removed ? replacement(family, removed, dependent.id) : [id];
    })
  ),
];

function removeLine<T extends Row>(
  family: readonly T[],
  first: readonly T[],
  reason: string,
  now: number
): Write<T>[] {
  const writes: Write<T>[] = [];
  let current = [...family];
  const queue = [...first];
  for (let todo = queue.shift(); todo; todo = queue.shift()) {
    const gone = { ...todo, state: 'removed' as const, replacedBy: null };
    writes.push({ todo, patch: { state: 'removed', reason, finishedAt: now } });
    current = current.map((item) => (item.id === gone.id ? gone : item));
    for (const next of current.filter(
      (item) => live(item) && prerequisites(current, item.id).includes(gone.id)
    )) {
      if (next.startedAt === null) {
        if (!queue.some((item) => item.id === next.id)) queue.push(next);
        continue;
      }
      const dependsOn = without(current, next, [gone]);
      writes.push({ todo: next, patch: { dependsOn } });
      current = current.map((item) => (item.id === next.id ? { ...item, dependsOn } : item));
    }
  }
  return writes;
}

const quoted = (todos: readonly Row[]) => todos.map((todo) => `"${todo.title}"`).join(', ');

export const neoRemovedPrerequisiteText = (gone: readonly Row[], dependents: readonly Row[]) =>
  `${quoted(gone)} ${gone.length > 1 ? 'were' : 'was'} removed. Continue ${quoted(dependents)} without ${
    gone.length > 1 ? 'them' : 'it'
  }, or remove ${dependents.length > 1 ? 'these steps' : 'this step'} too?`;

const onCard = (card: Card, id: string, kind: 'start' | 'removal') =>
  card.state === 'open' &&
  (kind === 'start' ? card.kind === 'start' : card.cause === NEO_REMOVED_PREREQUISITE) &&
  card.todos.includes(id);

export function planNeoTodoRemoval<T extends Row, C extends Card>(
  todo: T,
  family: readonly T[],
  cards: readonly C[],
  input: { root: string; replacedBy?: string | null; dependents?: 'continue' | 'remove' },
  now: number
): { writes: Write<T>[]; card: CardPlan<C> | null } {
  const gone = { ...todo, state: 'removed' as const, replacedBy: input.replacedBy ?? null };
  const after = family.map((item) => (item.id === todo.id ? gone : item));
  const writes: Write<T>[] = [];
  const undecided: T[] = [];
  for (const dependent of after.filter(
    (item) => live(item) && prerequisites(after, item.id).includes(todo.id)
  )) {
    const dependsOn = without(after, dependent, [gone]);
    const handed = replacement(after, gone, dependent.id).length > 0;
    if (handed || dependent.startedAt !== null || input.dependents === 'continue')
      writes.push({ todo: dependent, patch: { dependsOn } });
    else undecided.push(dependent);
  }
  if (input.dependents === 'remove') {
    const eased = after.map((item) => {
      const write = writes.find((done) => done.todo.id === item.id);
      return write ? { ...item, ...write.patch } : item;
    });
    const line = removeLine(
      eased,
      undecided.map((item) => eased.find((other) => other.id === item.id) ?? item),
      `Removed with its prerequisite "${todo.title}".`,
      now
    );
    const last = new Map(
      [...writes, ...line].map((write) => [
        write.todo.id,
        {
          todo: family.find((item) => item.id === write.todo.id) ?? write.todo,
          patch: write.patch,
        },
      ])
    );
    return { writes: [...last.values()], card: null };
  }
  const listed = undecided.filter(
    (dependent) => !cards.some((card) => onCard(card, dependent.id, 'start'))
  );
  if (!listed.length) return { writes, card: null };
  const replaces =
    cards.find((card) => listed.some((dependent) => onCard(card, dependent.id, 'removal'))) ?? null;
  const covered = new Set([
    ...(replaces?.todos ?? []),
    ...listed.map((dependent) => dependent.id),
    todo.id,
  ]);
  const waiting = after.filter(
    (item) => covered.has(item.id) && live(item) && item.startedAt === null
  );
  const prior = after.filter(
    (item) =>
      covered.has(item.id) &&
      waiting.some((dependent) =>
        neoTodoCancelledDependencies(after, dependent.id).some(
          (cancelled) => cancelled.id === item.id
        )
      )
  );
  return {
    writes,
    card: {
      askId: input.root,
      replaces,
      todos: [...waiting, ...prior].map((item) => item.id),
      text: neoRemovedPrerequisiteText(prior, waiting),
    },
  };
}

export function planNeoRemovedPrerequisiteAnswer<T extends Row>(
  question: Pick<NeoQuestion, 'cause' | 'todos'>,
  family: readonly T[],
  answer: NeoQuestionAnswer,
  now: number
): Write<T>[] {
  if (question.cause !== NEO_REMOVED_PREREQUISITE) return [];
  const [picked] = [answer].flat();
  const held = family.filter(
    (todo) => question.todos.includes(todo.id) && live(todo) && todo.startedAt === null
  );
  if (picked === NEO_REMOVED_PREREQUISITE_OPTIONS[1])
    return removeLine(
      family,
      held,
      'The human removed it after its prerequisite was removed.',
      now
    );
  if (picked !== NEO_REMOVED_PREREQUISITE_OPTIONS[0]) return [];
  const decided = (todo: T) =>
    neoTodoCancelledDependencies(family, todo.id).filter((gone) =>
      question.todos.includes(gone.id)
    );
  return held
    .filter((todo) => decided(todo).length > 0)
    .map((todo) => ({ todo, patch: { dependsOn: without(family, todo, decided(todo)) } }));
}
