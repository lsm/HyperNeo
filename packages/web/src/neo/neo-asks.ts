import type { NeoAskEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';

export const NEO_DONE_SHOWN = 3;

export type NeoDoneTodosPage =
  | { ok: true; todos: NeoTodoEntry[]; doneCount: number; nextOffset: number | null }
  | { ok: false; reason: string };

export type NeoAskGroup = 'attention' | 'running' | 'outcomes';

const holdsBlocked = (entry: Pick<NeoAskEntry, 'todos'>) =>
  entry.todos.some((todo) => todo.state === 'blocked');

export function neoAskEntryGroup(entry: Pick<NeoAskEntry, 'state' | 'todos'>): NeoAskGroup {
  return entry.state === 'waiting' || holdsBlocked(entry)
    ? 'attention'
    : entry.state === 'done' || entry.state === 'dropped'
      ? 'outcomes'
      : 'running';
}

export function neoAskEntriesInOrder<T extends Pick<NeoAskEntry, 'todos'>>(
  entries: readonly T[]
): T[] {
  return [...entries].sort((a, b) => Number(holdsBlocked(b)) - Number(holdsBlocked(a)));
}
