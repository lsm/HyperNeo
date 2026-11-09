import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTrackerAdapter, NeoTrackerItem, NeoTrackerOwner } from './pack-contract.ts';

export type NeoTrackerMirror = {
  ownerKind: 'ask' | 'todo';
  ownerId: string;
  tracker: string;
  home: string;
  ref: string | null;
  parentRef: string | null;
  state: 'creating' | 'bound' | 'closed';
  failures: number;
  updatedAt: number;
};
export type NeoTrackerPlan = {
  row: NeoTrackerMirror;
  adapter: NeoTrackerAdapter;
  item: NeoTrackerItem;
  action: 'create' | 'link' | 'close';
  parent?: string;
};
export const neoTrackerMarker = (owner: NeoTrackerOwner) =>
  `hyperneo:${owner.kind}:${owner.todo?.id ?? owner.ask.id}`;
export const readNeoTrackerMarker = (body: string) =>
  body.match(/hyperneo:(?:ask|todo):[\w-]+/)?.[0] ?? null;
export const planNeoTrackerRecovery = (row: NeoTrackerMirror, found: string | null) =>
  row.state === 'creating' && found ? { ref: found } : null;

export function planNeoTrackerMirror(
  asks: readonly NeoAsk[],
  todos: readonly NeoTodo[],
  mirrors: readonly NeoTrackerMirror[],
  adapters: readonly NeoTrackerAdapter[]
): NeoTrackerPlan[] {
  const owners = asks.flatMap((ask): NeoTrackerOwner[] => [
    { kind: 'ask', ask },
    ...todos
      .filter((todo) => todo.askId === ask.id && todo.state !== 'removed')
      .map((todo): NeoTrackerOwner => ({ kind: 'todo', ask, todo })),
  ]);
  const plans: NeoTrackerPlan[] = [];
  for (const adapter of adapters)
    for (const owner of owners) {
      if (!adapter.enabled(owner)) continue;
      const id = owner.todo?.id ?? owner.ask.id;
      const existing = mirrors.find(
        (row) => row.ownerKind === owner.kind && row.ownerId === id && row.tracker === adapter.id
      );
      const home = existing?.home ?? adapter.home(owner);
      if (!home || existing?.state === 'closed' || (!existing && owner.ask.status !== 'open'))
        continue;
      const row: NeoTrackerMirror = existing ?? {
        ownerKind: owner.kind,
        ownerId: id,
        tracker: adapter.id,
        home,
        ref: null,
        parentRef: null,
        state: 'creating',
        failures: 0,
        updatedAt: 0,
      };
      const marker = neoTrackerMarker(owner);
      const title = owner.todo?.title ?? owner.ask.title;
      const item = {
        home,
        marker,
        title,
        body: `${title}\n\n<!-- ${marker} -->`,
      };
      const parent = mirrors.find(
        (mirror) =>
          mirror.ownerKind === 'ask' &&
          mirror.ownerId === owner.ask.id &&
          mirror.tracker === adapter.id &&
          mirror.state === 'bound'
      )?.ref;
      if (row.state === 'creating') plans.push({ row, adapter, item, action: 'create' });
      else if (owner.kind === 'ask' && owner.ask.status !== 'open')
        plans.push({ row, adapter, item, action: 'close' });
      else if (owner.kind === 'todo' && parent && row.parentRef !== parent)
        plans.push({ row, adapter, item, action: 'link', parent });
    }
  return plans;
}
