import type { NeoAskEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';

export const NEO_DONE_SHOWN = 3;

export type NeoDoneTodosPage =
  | { ok: true; todos: NeoTodoEntry[]; doneCount: number; nextOffset: number | null }
  | { ok: false; reason: string };

export type NeoAskGroup = 'attention' | 'running' | 'outcomes';

const holdsBlocked = (entry: Pick<NeoAskEntry, 'todos'>) =>
  entry.todos.some((todo) => todo.state === 'blocked');

export function neoAskEntryGroup(entry: Pick<NeoAskEntry, 'state' | 'todos'>): NeoAskGroup {
  return entry.state === 'done' || entry.state === 'dropped'
    ? 'outcomes'
    : entry.state === 'waiting' || holdsBlocked(entry)
      ? 'attention'
      : 'running';
}

export function neoAskEntriesInOrder<T extends Pick<NeoAskEntry, 'ask' | 'state' | 'todos'>>(
  entries: readonly T[]
): T[] {
  return [...entries].sort((a, b) => {
    const waiting = Number(b.state === 'waiting') - Number(a.state === 'waiting');
    if (waiting) return waiting;
    if (a.state === 'waiting') {
      return b.ask.createdAt - a.ask.createdAt || a.ask.id.localeCompare(b.ask.id);
    }
    return Number(holdsBlocked(b)) - Number(holdsBlocked(a));
  });
}

export function neoDonePageMerge(
  paged: readonly NeoTodoEntry[],
  known: readonly NeoTodoEntry[],
  page: readonly NeoTodoEntry[],
  restart: boolean
): { paged: NeoTodoEntry[]; stalled: boolean } {
  const seen = new Set((restart ? [] : known).map((todo) => todo.id));
  const fresh = page.filter((todo) => !seen.has(todo.id) && !!seen.add(todo.id));
  return restart
    ? { paged: [...fresh, ...paged.filter((todo) => !seen.has(todo.id))], stalled: false }
    : { paged: [...paged, ...fresh], stalled: fresh.length === 0 };
}
