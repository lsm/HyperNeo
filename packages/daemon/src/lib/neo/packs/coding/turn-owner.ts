import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../../../drivers/types.ts';
import type { WorkTurnMention } from '../../../../storage/repositories/work-turn-repository.ts';
import { type TurnTodoFacts, turnKeyTodos } from '../../turn-todo.ts';
import { codingPrKey } from './pr-key.ts';

export type CodingTurnBind = { todo: string; boundAt: number; finishedAt: number | null };
export type CodingTurn = WorkTurnMention & { bound?: readonly CodingTurnBind[] };
export type CodingSessionTodos = Readonly<Record<string, TurnTodoFacts>>;
export type CodingTurnMentions = { turns: readonly CodingTurn[]; todos: CodingSessionTodos };
export type CodingTurnOwner =
  | { state: 'placed'; session: WorkRef; todo: string | null }
  | { state: 'unknown' }
  | { state: 'none' };

export type CodingTurnProducer =
  | { state: 'placed'; session: WorkRef; turns: readonly CodingTurn[] }
  | { state: 'unknown' }
  | { state: 'none' };

const ABORTED = /abort|interrupt/;
const NO_FACTS: TurnTodoFacts = { keys: {}, starter: null, roles: {} };

export const codingNamedPrKeys = (todo: Pick<NeoTodo, 'check'>) => {
  const urls =
    todo.check?.kind === 'pr_approved' ? [todo.check.params.url] : todo.check?.params.urls;
  return (Array.isArray(urls) ? urls : []).flatMap((url) =>
    typeof url === 'string' ? (codingPrKey(url) ?? []) : []
  );
};

const bindsOf = (turn: CodingTurn) =>
  (turn.bound ?? []).filter(
    ({ boundAt, finishedAt }) =>
      turn.endedAt >= boundAt && (finishedAt === null || turn.startedAt <= finishedAt)
  );

const startedAfterBind = (turn: CodingTurn) =>
  turn.inputs.length > 0 && bindsOf(turn).every(({ boundAt }) => turn.startedAt > boundAt);

const single = (todos: readonly string[]) => (todos.length === 1 ? [...todos] : []);

export function codingTurnTodos(turn: CodingTurn, facts: TurnTodoFacts): string[] {
  const own = turnKeyTodos(turn, facts.keys);
  if (own.length) return single(own);
  if (!turn.inputs.length && turn.previous && ABORTED.test(turn.previous.ended)) {
    const continued = turnKeyTodos(turn.previous, facts.keys);
    if (continued.length) return single(continued);
  }
  const binds = bindsOf(turn);
  if (!binds.length) return facts.starter ? [facts.starter] : [];
  return startedAfterBind(turn) ? [] : binds.map(({ todo }) => todo);
}

export function codingTurnBoundUnknown(turn: CodingTurn, facts: TurnTodoFacts): boolean {
  const binds = bindsOf(turn);
  return (
    binds.length > 0 &&
    !turnKeyTodos(turn, facts.keys).length &&
    (startedAfterBind(turn) || binds.length > 1)
  );
}

export const codingTurnSessionKey = ({ adapter, id, daemon }: WorkRef) =>
  JSON.stringify([adapter, id, daemon]);

export function planCodingTurnProducer(
  pr: { url: string; createdAt?: number },
  turns: readonly CodingTurn[]
): CodingTurnProducer {
  const key = codingPrKey(pr.url);
  const isPr = (url: string) => codingPrKey(url) === key;
  const shown = turns.filter((turn) => turn.urls.some(isPr));
  const { createdAt } = pr;
  if (createdAt === undefined) return shown.length ? { state: 'unknown' } : { state: 'none' };
  const inside = shown.filter((turn) => turn.startedAt <= createdAt && createdAt <= turn.endedAt);
  if (!inside.length) return { state: 'none' };
  if (inside.some((turn) => !turn.complete)) return { state: 'unknown' };
  const reported = inside.filter((turn) => turn.finalUrls.some(isPr));
  const placing = reported.length ? reported : inside;
  if (new Set(placing.map((turn) => codingTurnSessionKey(turn.ref))).size > 1)
    return { state: 'unknown' };
  if (!reported.length && (inside.length > 1 || inside[0].finalUrls.some(codingPrKey)))
    return { state: 'unknown' };
  return { state: 'placed', session: placing[0].ref, turns: placing };
}

export function planCodingTurnOwner(
  pr: { url: string; createdAt?: number },
  turns: readonly CodingTurn[],
  todos: CodingSessionTodos
): CodingTurnOwner {
  const producer = planCodingTurnProducer(pr, turns);
  if (producer.state !== 'placed') return producer;
  const placing = producer.turns;
  const sessionTodos = (turn: CodingTurn) => todos[codingTurnSessionKey(turn.ref)] ?? NO_FACTS;
  if (placing.some((turn) => codingTurnBoundUnknown(turn, sessionTodos(turn))))
    return { state: 'unknown' };
  const owners = [...new Set(placing.flatMap((turn) => codingTurnTodos(turn, sessionTodos(turn))))];
  return { state: 'placed', session: placing[0].ref, todo: owners.length === 1 ? owners[0] : null };
}

const MAX_TURN_PRS = 8;

export function planCodingTurnUrls(
  todo: Pick<NeoTodo, 'check'>,
  own: readonly Pick<CodingTurn, 'urls' | 'finalUrls'>[]
) {
  const keys = (urls: readonly string[]) => urls.flatMap((url) => codingPrKey(url) ?? []);
  const reported = new Set([
    ...codingNamedPrKeys(todo),
    ...keys(own.flatMap((turn) => turn.finalUrls)),
  ]);
  const shown = [...new Set(keys(own.flatMap((turn) => turn.urls)))].filter(
    (url) => !reported.has(url)
  );
  return [...reported, ...shown.slice(0, Math.max(0, MAX_TURN_PRS - reported.size))];
}

export function planCodingTurnOwned(
  todo: Pick<NeoTodo, 'id' | 'check'>,
  prs: readonly { url: string; createdAt?: number }[],
  mentions: CodingTurnMentions
) {
  const named = new Set(codingNamedPrKeys(todo));
  return prs.flatMap(({ url, createdAt }) => {
    const owner = planCodingTurnOwner({ url, createdAt }, mentions.turns, mentions.todos);
    return named.has(url) || (owner.state === 'placed' && owner.todo === todo.id) ? url : [];
  });
}

export function planCodingTurnFacts(
  todo: Pick<NeoTodo, 'id' | 'check'>,
  own: readonly Pick<CodingTurn, 'complete' | 'finalUrls'>[],
  urls: readonly string[],
  read: readonly NeoWorkPr[] | null,
  mentions: CodingTurnMentions,
  observedAt: number
): { prs: readonly NeoWorkPr[]; observedAt: number; incomplete?: true } {
  const unknown = { prs: [], observedAt, incomplete: true as const };
  const found = (url: string) => read?.find((pr) => codingPrKey(pr.url) === url);
  const named = new Set(codingNamedPrKeys(todo));
  const explicit = named.size > 0 && ['pr_merged', 'pr_approved'].includes(todo.check?.kind ?? '');
  const reported = own.flatMap((turn) => turn.finalUrls.flatMap((url) => codingPrKey(url) ?? []));
  if (!read || [...named].some((url) => !found(url))) return unknown;
  if (!explicit && (own.some((turn) => !turn.complete) || reported.some((url) => !found(url))))
    return unknown;
  const owners = urls.filter(found).map((url) => ({
    url,
    owner: planCodingTurnOwner(found(url)!, mentions.turns, mentions.todos),
  }));
  if (!explicit && owners.some(({ url, owner }) => !named.has(url) && owner.state === 'unknown'))
    return unknown;
  return {
    prs: owners.flatMap(({ url, owner }) =>
      named.has(url) || (owner.state === 'placed' && owner.todo === todo.id) ? found(url)! : []
    ),
    observedAt,
  };
}
