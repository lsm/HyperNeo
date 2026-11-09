import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTrackerAdapter } from './pack-contract.ts';
import { NEO_TRACKER_FAILURE_LIMIT, type NeoTrackerMirror } from './tracker-mirror-plan.ts';

export const neoTrackerHold = (
  todo: NeoTodo,
  mirror: NeoTrackerMirror | undefined,
  enabled: boolean
): string | null =>
  !enabled ||
  todo.startedAt !== null ||
  mirror?.ref ||
  (mirror?.failures ?? 0) >= NEO_TRACKER_FAILURE_LIMIT
    ? null
    : 'tracker_pending: waiting for the tracker item before starting this todo.';

export function planNeoTrackerStarts(
  facts: {
    asks: readonly NeoAsk[];
    todos: readonly NeoTodo[];
    mirrors: readonly NeoTrackerMirror[];
  },
  adapters: readonly NeoTrackerAdapter[]
) {
  const holds: Record<string, string | null> = {};
  const missing = new Set<NeoTodo>();
  for (const todo of facts.todos) {
    const ask = facts.asks.find((ask) => ask.id === todo.askId && ask.status === 'open');
    if (!ask || todo.state !== 'todo' || todo.startedAt !== null) continue;
    for (const adapter of adapters) {
      if (!adapter.enabled({ kind: 'todo', ask, todo })) continue;
      const mirror = facts.mirrors.find(
        (row) => row.ownerKind === 'todo' && row.ownerId === todo.id && row.tracker === adapter.id
      );
      holds[todo.id] ??= neoTrackerHold(todo, mirror, true);
      if (mirror && !mirror.ref && mirror.failures >= NEO_TRACKER_FAILURE_LIMIT) missing.add(todo);
    }
  }
  return { holds, missing: [...missing] };
}
