import type { NeoSessionNotice } from '@hyperneo/shared/types/neo-snapshot';
import type { PlaceGroup, WorkRef, WorkStatus } from '../drivers/types.ts';

export type { NeoSessionNotice };

export const NEO_SESSION_RUN_MS = 3 * 60_000;
export const NEO_SESSION_HUMAN_MS = 2 * 60_000;
export const NEO_SESSION_NOTICES_MAX = 20;
const NEO_SESSION_ACTIVE_MS = 24 * 60 * 60_000;

type NeoSessionNoticeKind = NeoSessionNotice['kind'];

export interface NeoListedSession {
  key: string;
  ref: WorkRef;
  title: string;
  status: WorkStatus;
  lastActivityAt: number;
  link?: string;
}

export interface NeoSessionSeen {
  listed: string;
  status: WorkStatus;
  runningSince: number | null;
}

export const neoSessionKey = (ref: WorkRef) => `${ref.adapter}:${ref.daemon ?? ''}:${ref.id}`;

const fingerprint = (session: NeoListedSession) => `${session.status}:${session.lastActivityAt}`;

export function listNeoWatchedSessions(
  places: readonly PlaceGroup[],
  cards: readonly WorkRef[],
  now: number
): NeoListedSession[] {
  const skip = new Set(cards.map(neoSessionKey));
  return places
    .flatMap((place) => place.work)
    .filter((work) => now - work.lastActivityAt < NEO_SESSION_ACTIVE_MS)
    .map((work) => ({
      key: neoSessionKey(work.ref),
      ref: work.ref,
      title: work.title,
      status: work.status,
      lastActivityAt: work.lastActivityAt,
      ...(work.link ? { link: work.link } : {}),
    }))
    .filter((session) => !skip.has(session.key));
}

export function planNeoSessionWatch(
  listed: readonly NeoListedSession[],
  seen: ReadonlyMap<string, NeoSessionSeen>,
  now: number
): { baseline: [string, NeoSessionSeen][]; reads: NeoListedSession[] } {
  return {
    baseline: listed
      .filter((session) => !seen.has(session.key))
      .map((session) => [
        session.key,
        {
          listed: fingerprint(session),
          status: session.status,
          runningSince: session.status === 'running' ? now : null,
        },
      ]),
    reads: listed.filter((session) => {
      const prior = seen.get(session.key);
      return !!prior && prior.listed !== fingerprint(session);
    }),
  };
}

export function planNeoSessionNotice(
  session: NeoListedSession,
  prior: NeoSessionSeen,
  detail: { status: WorkStatus; lastInputAt: number | null } | null,
  now: number
): { seen: NeoSessionSeen; notice: NeoSessionNotice | null } {
  const status = detail?.status ?? session.status;
  const seen = {
    listed: fingerprint(session),
    status,
    runningSince: status === 'running' ? (prior.runningSince ?? now) : null,
  };
  const human = detail?.lastInputAt != null && now - detail.lastInputAt < NEO_SESSION_HUMAN_MS;
  const kind: NeoSessionNoticeKind | null = !detail
    ? null
    : status === 'needs_you' && prior.status !== 'needs_you'
      ? 'needs_you'
      : status === 'failed' && prior.status !== 'failed'
        ? 'failed'
        : status === 'done' &&
            prior.status === 'running' &&
            prior.runningSince !== null &&
            now - prior.runningSince >= NEO_SESSION_RUN_MS
          ? 'finished'
          : null;
  if (kind && human) return { seen: prior, notice: null };
  return {
    seen,
    notice: kind
      ? {
          key: session.key,
          ref: session.ref,
          title: session.title,
          kind,
          at: now,
          ...(session.link ? { link: session.link } : {}),
        }
      : null,
  };
}

export function keepNeoSessionNotices(
  kept: readonly NeoSessionNotice[],
  added: readonly NeoSessionNotice[]
): NeoSessionNotice[] {
  return [...kept, ...added].slice(-NEO_SESSION_NOTICES_MAX);
}
