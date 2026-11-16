import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoHumanQueue, NeoHumanQueueItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoStepOwner } from './attention/owner.ts';
import { neoTodoCovered } from './todo-state.ts';

const UNFINISHED: readonly NeoTodo['state'][] = ['todo', 'doing', 'blocked', 'failed'];

export function neoHumanQueue(input: {
  questions: readonly Pick<
    NeoQuestion,
    'id' | 'askId' | 'state' | 'text' | 'todos' | 'heldAt' | 'createdAt'
  >[];
  todos: readonly Pick<NeoTodo, 'id' | 'askId' | 'title' | 'state'>[];
  owners: ReadonlyMap<string, NeoStepOwner>;
}): NeoHumanQueue {
  const cards = input.questions.filter((card) => card.state === 'open');
  const items: NeoHumanQueueItem[] = [
    ...[...cards]
      .sort((a, b) => Number(!!a.heldAt) - Number(!!b.heldAt) || b.createdAt - a.createdAt)
      .map((card) => ({
        state: card.heldAt ? ('held' as const) : ('waiting' as const),
        askId: card.askId,
        questionId: card.id,
        text: card.text,
        todos: input.todos
          .filter((todo) => card.todos.includes(todo.id))
          .map(({ id, title }) => ({ id, title })),
      })),
    ...input.todos
      .filter((todo) => UNFINISHED.includes(todo.state) && !neoTodoCovered(todo, cards))
      .map((todo) => ({
        state: 'progress' as const,
        askId: todo.askId,
        todoId: todo.id,
        title: todo.title,
        owner: input.owners.get(todo.id)?.owner ?? null,
      })),
  ];
  const counts: NeoHumanQueue['counts'] = {};
  for (const item of items)
    (counts[item.askId] ??= { waiting: 0, held: 0, progress: 0 })[item.state]++;
  return { items, counts };
}
