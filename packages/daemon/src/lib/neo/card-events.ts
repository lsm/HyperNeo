import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoWorkClosedDone } from '@hyperneo/shared/types/neo-snapshot';
import type { WorkRef } from '../drivers/types.ts';
import type { ExternalEvent } from '../external-events/types.ts';
import { topicMatchesPattern } from '../external-events/topic-trie.ts';
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

export function neoCardWorkerSession(send: NeoCardSend): string | null {
  if (send.via === 'session') return send.sessionId;
  return send.via === 'driver' && send.ref.adapter === 'hyperneo' && !send.ref.daemon
    ? send.ref.id
    : null;
}

export function isNeoSessionTopicCovered(
  followed: readonly { session: string | null; topic: string }[],
  sessionId: string,
  topic: string
): boolean {
  return followed.some(
    (card) => card.session === sessionId && topicMatchesPattern(card.topic, topic)
  );
}

const PROJECT_EVENT = 'neo-project-event:';

export function neoProjectEventMessageId(projectId: string, eventId: string): string {
  return `${PROJECT_EVENT}${projectId}:${eventId}`;
}

export function isNeoProjectEventTurn(turn: { messageId: string } | undefined): boolean {
  return !!turn?.messageId.startsWith(PROJECT_EVENT);
}

export function planNeoProjectEventHolders(
  cards: readonly { projectId: string | null; owner: string | null }[]
): string[] {
  return [
    ...new Set(
      cards.flatMap((card) =>
        card.projectId && card.projectId !== card.owner ? [card.projectId] : []
      )
    ),
  ];
}
