import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoWorkClosedDone } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../drivers/types.ts';
import type { ExternalEvent } from '../external-events/types.ts';
import type { NeoCardEventSubscription, NeoPack, NeoPackEventRoute } from './packs/types.ts';

export interface NeoCardSendTarget {
  work: Pick<NeoWork, 'id' | 'status' | 'report' | 'sessionId'> | null;
  ref: WorkRef | null;
}

export type NeoCardSend =
  | { via: 'driver'; ref: WorkRef }
  | { via: 'session'; sessionId: string }
  | { via: 'none' };

export function isNeoCardLive(
  work: Pick<NeoWork, 'status' | 'report'> | null
): work is Pick<NeoWork, 'status' | 'report'> {
  return (
    !!work &&
    (work.status === 'queued' || work.status === 'reported') &&
    !isNeoWorkClosedDone(work.report)
  );
}

export function planNeoCardTopicsEnded(
  rows: readonly NeoCardEventSubscription[],
  followed: ReadonlyMap<string, boolean>
): NeoCardEventSubscription[] {
  return rows.filter((row) => !followed.get(row.workId));
}

export function planNeoCardSend({ work, ref }: NeoCardSendTarget): NeoCardSend {
  if (!isNeoCardLive(work)) return { via: 'none' };
  if (ref) return { via: 'driver', ref };
  return work.sessionId ? { via: 'session', sessionId: work.sessionId } : { via: 'none' };
}

export function planNeoCardEventRoute(
  packs: readonly Pick<NeoPack, 'routeExternalEvent'>[],
  event: ExternalEvent,
  subscriptions: readonly NeoCardEventSubscription[]
): { value: NeoPackEventRoute } | { reason: 'not_followed' } {
  const routes = packs.flatMap((pack) => pack.routeExternalEvent?.(event, subscriptions) ?? []);
  const route = {
    workIds: [...new Set(routes.flatMap((item) => item.workIds))],
    ending: routes.flatMap((item) => item.ending),
  };
  return route.workIds.length || route.ending.length
    ? { value: route }
    : { reason: 'not_followed' };
}

export function planNeoSessionTopicsHandedOver<Row extends { topic: string }>(
  own: readonly Row[],
  topics: readonly string[]
): Row[] {
  const owned = new Set(topics.map((topic) => topic.toLowerCase()));
  return own.filter((row) => owned.has(row.topic.toLowerCase()));
}
