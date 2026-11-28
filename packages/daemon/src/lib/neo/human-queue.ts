import type { NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  neoHumanQueueCounts,
  type NeoHumanQueue,
  type NeoHumanQueueItem,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoStepFacts, NeoStepOwner } from './attention/owner.ts';
import { neoTodoCovered } from './todo-state.ts';

const UNFINISHED: readonly NeoTodo['state'][] = ['todo', 'doing', 'blocked'];
const DAY = 24 * 60 * 60 * 1000;

type StepOwner = NeoStepOwner & Partial<Pick<NeoStepFacts, 'worker' | 'start'>>;
type QueueTodo = Extract<NeoHumanQueueItem, { todoId: string }>;

type HeldTodo = Pick<NeoTodo, 'hold' | 'blockedReason'>;

function queueStep(
  row: StepOwner | undefined,
  todo: Partial<HeldTodo>
): Pick<QueueTodo, 'step' | 'waitingOn' | 'reason'> {
  switch (row?.owner) {
    case 'worker':
      if (row.worker?.status === 'running') return { step: 'working' };
      if (row.worker?.status === 'queued') return { step: 'waiting', waitingOn: 'queue' };
      return {};
    case 'pack':
      return { step: 'waiting', waitingOn: 'review' };
    case 'prerequisite':
      return { step: 'waiting', waitingOn: 'earlier_step' };
    case 'daemon':
      return { step: 'waiting', waitingOn: row.start === 'held' ? 'queue' : 'checking' };
    case 'nobody':
      return todo.hold?.by === 'human'
        ? { step: 'paused' }
        : {
            step: 'waiting',
            waitingOn: 'hold',
            ...(todo.blockedReason ? { reason: todo.blockedReason } : {}),
          };
    case 'neo':
      return { step: 'neo' };
    case 'human':
      return { step: 'you' };
    default:
      return {};
  }
}

const neoStalled = (owner: NeoStepOwner | undefined, now: number | undefined) =>
  owner?.owner === 'neo' && now !== undefined && now - owner.since >= DAY;

export function neoHumanQueue(input: {
  questions: readonly Pick<
    NeoQuestion,
    'id' | 'askId' | 'state' | 'text' | 'todos' | 'heldAt' | 'createdAt'
  >[];
  todos: readonly (Pick<NeoTodo, 'id' | 'askId' | 'title' | 'state' | 'named'> &
    Partial<HeldTodo>)[];
  owners: ReadonlyMap<string, StepOwner>;
  now?: number;
}): NeoHumanQueue {
  const cards = input.questions.filter((card) => card.state === 'open');
  const items: NeoHumanQueueItem[] = [
    ...[...cards]
      .sort(
        (a, b) =>
          Number(!!a.heldAt) - Number(!!b.heldAt) ||
          b.createdAt - a.createdAt ||
          a.id.localeCompare(b.id)
      )
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
      .filter(
        (todo) =>
          UNFINISHED.includes(todo.state) &&
          typeof todo.named?.requestFrom !== 'string' &&
          !neoTodoCovered(todo, cards)
      )
      .map((todo): QueueTodo => {
        const row = input.owners.get(todo.id);
        return {
          state: neoStalled(row, input.now) ? 'waiting' : 'progress',
          askId: todo.askId,
          todoId: todo.id,
          title: todo.title,
          owner: row?.owner ?? null,
          ...queueStep(row, todo),
        };
      }),
  ];
  return { items, counts: neoHumanQueueCounts({ items }) };
}
