import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoHumanQueue,
  NeoHumanQueueItem,
  NeoHumanQueueState,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoStepOwner } from './attention/owner.ts';
import { neoQuestionCoversTodo } from './todo-state.ts';

const UNFINISHED: readonly NeoTodo['state'][] = ['todo', 'doing', 'blocked', 'failed'];

export function neoHumanQueue(input: {
  questions: readonly Pick<NeoQuestion, 'id' | 'askId' | 'state' | 'text' | 'todos' | 'heldAt'>[];
  asks: readonly Pick<NeoAsk, 'id'>[];
  todos: readonly Pick<NeoTodo, 'id' | 'askId' | 'title' | 'state'>[];
  owners: ReadonlyMap<string, NeoStepOwner>;
  state?: NeoHumanQueueState;
  askId?: string | null;
}): NeoHumanQueue {
  const { state = 'waiting', askId = null } = input;
  const all = input.asks.flatMap((ask): NeoHumanQueueItem[] => {
    const cards = input.questions.filter((card) => card.askId === ask.id && card.state === 'open');
    return [
      ...cards.map((card) => ({
        state: card.heldAt ? ('held' as const) : ('waiting' as const),
        askId: ask.id,
        questionId: card.id,
        text: card.text,
        todos: input.todos
          .filter((todo) => card.todos.includes(todo.id))
          .map(({ id, title }) => ({ id, title })),
      })),
      ...input.todos
        .filter(
          (todo) =>
            todo.askId === ask.id &&
            UNFINISHED.includes(todo.state) &&
            !cards.some((card) => neoQuestionCoversTodo(card, todo))
        )
        .map((todo) => ({
          state: 'progress' as const,
          askId: ask.id,
          todoId: todo.id,
          title: todo.title,
          owner: input.owners.get(todo.id)?.owner ?? null,
        })),
    ];
  });
  const counts: NeoHumanQueue['counts'] = {};
  for (const item of all)
    (counts[item.askId] ??= { waiting: 0, held: 0, progress: 0 })[item.state]++;
  return {
    state,
    askId,
    items: all.filter((item) => item.state === state && (!askId || item.askId === askId)),
    counts,
  };
}
