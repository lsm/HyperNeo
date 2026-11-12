import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { isNeoTodoStalledCard } from './todo-state.ts';

type StoredBlock = Pick<
  NeoTodo,
  'id' | 'askId' | 'title' | 'state' | 'blockedBy' | 'blockedReason' | 'startedAt' | 'report'
>;

interface OpenCard {
  text: string;
  todos: readonly string[];
  bound: readonly string[];
}

export interface NeoBlockCard {
  askId: string;
  todoId: string;
  text: string;
  kind: 'reply' | 'choice';
  options: string[] | null;
  document: string | null;
}

const tiedToCard = (todo: StoredBlock, cards: readonly OpenCard[]) =>
  todo.blockedBy === 'needs-human'
    ? cards.some((card) => card.bound.includes(todo.id))
    : todo.blockedBy === 'stalled'
      ? cards.some((card) => card.todos.includes(todo.id) && isNeoTodoStalledCard(card.text))
      : todo.blockedBy === 'question' || todo.blockedBy === null;

/** @public */
export function planNeoBlockCards(
  todos: readonly StoredBlock[],
  cards: readonly OpenCard[]
): NeoBlockCard[] {
  return todos
    .filter((todo) => todo.state === 'blocked' && !tiedToCard(todo, cards))
    .map((todo) => {
      const held = todo.blockedBy === 'held';
      const reason = todo.blockedReason ?? 'It is blocked.';
      return {
        askId: todo.askId,
        todoId: todo.id,
        text: held ? `"${todo.title}" is on hold: ${reason}` : `"${todo.title}": ${reason}`,
        kind: held ? 'choice' : 'reply',
        options: held ? [todo.startedAt === null ? 'Start' : 'Resume', 'Remove'] : null,
        document: todo.report,
      };
    });
}
