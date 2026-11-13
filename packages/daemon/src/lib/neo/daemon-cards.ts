import type { NeoQuestion, NeoStatusCode, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoQuestionDraft } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { neoStatusLine } from './status-codes.ts';
import { neoTodoCovered } from './todo-state.ts';

export const NEO_WORKER_BLOCKER = 'worker_blocker';
export const NEO_RETRIES_EXHAUSTED = 'retries_exhausted';
export const NEO_CHECK_OVERDUE = 'check_overdue';
export const NEO_AUTOMATIC_RETRIES = 2;
export const NEO_CHECK_DEADLINE_MS = 24 * 60 * 60 * 1000;

const MARK_DONE = 'Mark done';
const REMOVE = 'Remove';
const RETRY = 'Retry';
const KEEP_WAITING = 'Keep waiting';

type Cause = typeof NEO_WORKER_BLOCKER | typeof NEO_RETRIES_EXHAUSTED | typeof NEO_CHECK_OVERDUE;

const OPTIONS: Record<Cause, string[]> = {
  [NEO_WORKER_BLOCKER]: [MARK_DONE, REMOVE],
  [NEO_RETRIES_EXHAUSTED]: [RETRY, MARK_DONE, REMOVE],
  [NEO_CHECK_OVERDUE]: [KEEP_WAITING, MARK_DONE, REMOVE],
};

const OPTION_CODES: Record<string, string> = {
  [MARK_DONE]: 'question.daemonMarkDone',
  [REMOVE]: 'question.daemonRemove',
  [RETRY]: 'question.daemonRetry',
  [KEEP_WAITING]: 'question.daemonKeepWaiting',
};

const DAEMON_EN = {
  'question.workerBlocker':
    '{steps} is blocked: {reason}. Reply to its worker, mark it done, or remove it?',
  'question.retriesExhausted':
    '{steps} could not start after {retries} automatic retries: {reason}. Retry, mark done, or remove?',
  'question.checkOverdue':
    "{steps} has waited {hours} hours and its check hasn't passed. Keep waiting, mark it done, or remove it?",
} as const;

const TEXT_CODES: Record<Cause, keyof typeof DAEMON_EN> = {
  [NEO_WORKER_BLOCKER]: 'question.workerBlocker',
  [NEO_RETRIES_EXHAUSTED]: 'question.retriesExhausted',
  [NEO_CHECK_OVERDUE]: 'question.checkOverdue',
};

type Row = Pick<NeoTodo, 'id' | 'title' | 'state' | 'blockedReason' | 'updatedAt'>;
type Covered = Row & Pick<NeoTodo, 'blockedBy' | 'check'>;
type Card = Pick<
  NeoQuestion,
  'id' | 'state' | 'cause' | 'todos' | 'text' | 'answer' | 'answeredAt' | 'options'
>;

const isCause = (cause: string | null | undefined): cause is Cause => !!cause && cause in OPTIONS;

const live = (todo: Pick<NeoTodo, 'state'>) =>
  ['todo', 'doing', 'blocked', 'failed'].includes(todo.state);

const quoted = (todos: readonly Pick<Row, 'title'>[]) =>
  todos.map((todo) => `"${todo.title}"`).join(', ');

function daemonLine(cause: Cause, covered: readonly Row[]) {
  return neoStatusLine(DAEMON_EN, [
    {
      code: TEXT_CODES[cause],
      params: {
        steps: quoted(covered),
        reason: (covered[0]?.blockedReason ?? '').replace(/[.。\s]+$/, ''),
        retries: String(NEO_AUTOMATIC_RETRIES),
        hours: String(NEO_CHECK_DEADLINE_MS / 3_600_000),
      },
    },
  ]);
}

export function neoDaemonCardDraft(cause: Cause, covered: readonly Row[]): NeoQuestionDraft {
  return {
    text: daemonLine(cause, covered).status,
    kind: 'choice',
    options: OPTIONS[cause],
    multiple: false,
    noLabel: null,
    yesLabel: null,
    startTodos: null,
    todos: covered.map((todo) => todo.id),
    cause,
  };
}

export function neoDaemonCardCodes(
  question: Pick<NeoQuestion, 'cause' | 'text' | 'todos' | 'options'>,
  family: readonly Row[]
): { textCodes?: NeoStatusCode[]; optionCodes?: NeoStatusCode[] } {
  if (!isCause(question.cause)) return {};
  const covered = question.todos.flatMap((id) => family.filter((todo) => todo.id === id));
  const line = daemonLine(question.cause, covered);
  const standard = question.options?.join('\n') === OPTIONS[question.cause].join('\n');
  return {
    ...(line.status === question.text ? { textCodes: line.statusCodes } : {}),
    ...(standard
      ? {
          optionCodes: OPTIONS[question.cause].map((option) => ({
            code: OPTION_CODES[option],
            params: {},
          })),
        }
      : {}),
  };
}

const blockedBy = (todo: Covered, ...by: NeoTodo['blockedBy'][]) =>
  todo.state === 'blocked' && by.includes(todo.blockedBy);

const covers: Record<Cause, (todo: Covered) => boolean> = {
  [NEO_WORKER_BLOCKER]: (todo) => blockedBy(todo, 'needs-human', 'question'),
  [NEO_RETRIES_EXHAUSTED]: (todo) => blockedBy(todo, 'failure'),
  [NEO_CHECK_OVERDUE]: (todo) =>
    !!todo.check && (todo.state === 'todo' || blockedBy(todo, 'question')),
};

export function planNeoDaemonCardPrune(
  question: Pick<NeoQuestion, 'cause' | 'todos' | 'text'>,
  family: readonly Covered[]
) {
  if (!isCause(question.cause)) return null;
  const cause = question.cause;
  const kept = question.todos.flatMap((id) =>
    family.filter((todo) => todo.id === id && covers[cause](todo))
  );
  if (kept.length === question.todos.length) return null;
  return {
    kept: kept.map((todo) => todo.id),
    text: kept.length ? neoDaemonCardDraft(cause, kept).text : question.text,
    state: kept.length ? ('open' as const) : ('retired' as const),
    retiredReason: kept.length ? null : 'nothing left to decide',
    released: [],
  };
}

export const neoStartRetryDue = (retries: number) => retries < NEO_AUTOMATIC_RETRIES;

export function planNeoRetriesCard<C extends Card>(
  todo: Row,
  family: readonly Row[],
  cards: readonly C[]
): { replaces: C | null; draft: NeoQuestionDraft } | null {
  const open = cards.filter((card) => card.state === 'open');
  if (neoTodoCovered(todo, open)) return null;
  const shared =
    open.find(
      (card) =>
        card.cause === NEO_RETRIES_EXHAUSTED &&
        card.todos.some(
          (id) => family.find((item) => item.id === id)?.blockedReason === todo.blockedReason
        )
    ) ?? null;
  const covered = [
    ...(shared?.todos ?? []).flatMap((id) => family.filter((item) => item.id === id && live(item))),
    todo,
  ];
  return { replaces: shared, draft: neoDaemonCardDraft(NEO_RETRIES_EXHAUSTED, covered) };
}

export function neoCheckOverdue(
  todo: Pick<NeoTodo, 'id' | 'createdAt'>,
  cards: readonly Card[],
  now: number
): boolean {
  if (neoTodoCovered(todo, cards)) return false;
  const waited = cards
    .filter(
      (card) =>
        card.cause === NEO_CHECK_OVERDUE &&
        card.state === 'answered' &&
        card.todos.includes(todo.id)
    )
    .reduce((at, card) => Math.max(at, card.answeredAt ?? 0), todo.createdAt);
  return now - waited >= NEO_CHECK_DEADLINE_MS;
}

export type NeoDaemonCardAction = {
  todoId: string;
  name: 'neo.todo.done' | 'neo.todo.remove' | 'neo.todo.retry';
  input: Record<string, string>;
};

export function planNeoDaemonCardActions(card: Card, todos: readonly Row[]): NeoDaemonCardAction[] {
  if (!isCause(card.cause) || card.state !== 'answered' || card.answeredAt === null) return [];
  const [picked] = [card.answer].flat();
  const covered = card.todos.flatMap((id) => todos.filter((todo) => todo.id === id && live(todo)));
  if (picked === MARK_DONE)
    return covered.map((todo) => ({
      todoId: todo.id,
      name: 'neo.todo.done',
      input: { todoId: todo.id, reason: 'The human marked it done on a card.' },
    }));
  if (picked === REMOVE)
    return covered.map((todo) => ({
      todoId: todo.id,
      name: 'neo.todo.remove',
      input: { todoId: todo.id, reason: 'The human removed it on a card.' },
    }));
  if (picked !== RETRY) return [];
  const answeredAt = card.answeredAt;
  return covered
    .filter(
      (todo) =>
        todo.updatedAt <= answeredAt && (todo.state === 'failed' || todo.state === 'blocked')
    )
    .map((todo) => ({ todoId: todo.id, name: 'neo.todo.retry', input: { todoId: todo.id } }));
}
