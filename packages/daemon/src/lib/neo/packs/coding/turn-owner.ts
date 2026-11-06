import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../../../drivers/types.ts';
import type { WorkTurnMention } from '../../../../storage/repositories/work-turn-repository.ts';
import { codingPrKey } from './pr-key.ts';

export type CodingTurn = WorkTurnMention;
export type CodingTurnTodos = Readonly<Record<string, string>>;
export type CodingTurnMentions = { turns: readonly CodingTurn[]; todos: CodingTurnTodos };
export type CodingTurnOwner =
  | { state: 'placed'; session: WorkRef; todo: string | null }
  | { state: 'unknown' }
  | { state: 'none' };

const ABORTED = /abort|interrupt/;

const namedPrKeys = (todo: Pick<NeoTodo, 'check'>) => {
  const urls = todo.check?.params.urls;
  return (Array.isArray(urls) ? urls : []).flatMap((url) =>
    typeof url === 'string' ? (codingPrKey(url) ?? []) : []
  );
};

const todosIn = (turn: Pick<CodingTurn, 'id' | 'inputs'>, todos: CodingTurnTodos) => [
  ...new Set([turn.id, ...turn.inputs].flatMap((id) => todos[id] ?? [])),
];

export function codingTurnTodos(turn: CodingTurn, todos: CodingTurnTodos): string[] {
  const own = todosIn(turn, todos);
  return own.length || turn.inputs.length || !turn.previous || !ABORTED.test(turn.previous.ended)
    ? own
    : todosIn(turn.previous, todos);
}

const sessionKey = ({ adapter, id, daemon }: WorkRef) => JSON.stringify([adapter, id, daemon]);

export function planCodingTurnOwner(
  pr: { url: string; createdAt?: number },
  turns: readonly CodingTurn[],
  todos: CodingTurnTodos
): CodingTurnOwner {
  const key = codingPrKey(pr.url);
  const shown = turns.filter((turn) => turn.urls.some((url) => codingPrKey(url) === key));
  const { createdAt } = pr;
  if (createdAt === undefined) return shown.length ? { state: 'unknown' } : { state: 'none' };
  const inside = shown.filter((turn) => turn.startedAt <= createdAt && createdAt <= turn.endedAt);
  if (!inside.length) return { state: 'none' };
  if (inside.some((turn) => !turn.complete)) return { state: 'unknown' };
  if (new Set(inside.map((turn) => sessionKey(turn.ref))).size > 1) return { state: 'unknown' };
  const owners = [...new Set(inside.flatMap((turn) => codingTurnTodos(turn, todos)))];
  return { state: 'placed', session: inside[0].ref, todo: owners.length === 1 ? owners[0] : null };
}

export const planCodingTurnUrls = (
  todo: Pick<NeoTodo, 'check'>,
  own: readonly Pick<CodingTurn, 'urls'>[]
) => [
  ...new Set([
    ...namedPrKeys(todo),
    ...own.flatMap((turn) => turn.urls.flatMap((url) => codingPrKey(url) ?? [])),
  ]),
];

export function planCodingTurnFacts(
  todo: Pick<NeoTodo, 'id' | 'check'>,
  own: readonly Pick<CodingTurn, 'complete'>[],
  urls: readonly string[],
  read: readonly NeoWorkPr[] | null,
  mentions: CodingTurnMentions,
  observedAt: number
): { prs: readonly NeoWorkPr[]; observedAt: number; incomplete?: true } {
  const unknown = { prs: [], observedAt, incomplete: true as const };
  const found = (url: string) => read?.find((pr) => codingPrKey(pr.url) === url);
  if (own.some((turn) => !turn.complete) || urls.some((url) => !found(url))) return unknown;
  const named = new Set(namedPrKeys(todo));
  const owners = urls.map((url) => ({
    url,
    owner: planCodingTurnOwner(found(url)!, mentions.turns, mentions.todos),
  }));
  if (owners.some(({ url, owner }) => !named.has(url) && owner.state === 'unknown')) return unknown;
  return {
    prs: owners.flatMap(({ url, owner }) =>
      named.has(url) || (owner.state === 'placed' && owner.todo === todo.id) ? found(url)! : []
    ),
    observedAt,
  };
}
