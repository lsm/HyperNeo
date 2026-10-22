import { WorkerIdentitySchema } from '../drivers/worker-identity-schema.ts';
import { workerEngine } from '@hyperneo/shared/types/worker-identity';
import type { NeoSessionNotice, NeoSessionNoticeGroup } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { NeoStatusCodesSchema, neoStatusLine } from './status-codes.ts';
import { type PlaceGroup, type WorkRef, WorkRefSchema, type WorkStatus } from '../drivers/types.ts';

export type { NeoSessionNotice, NeoSessionNoticeGroup };

const NEO_SESSION_HUMAN_MS = 2 * 60_000;
export const NEO_SESSION_NOTICES_MAX = 20;
export const NEO_SESSION_WATCH_LIMIT = 30;
export const NEO_SESSION_GROUP_NOTICES_MAX = 30;
export const NeoSessionNoticeSchema = z.object({
  worker: WorkerIdentitySchema.optional(),
  key: z.string(),
  ref: WorkRefSchema,
  title: z.string(),
  kind: z.enum(['needs_you', 'failed', 'finished']),
  at: z.number(),
  link: z.string().optional(),
  remoteLink: z.string().optional(),
});
export const NeoSessionNoticeGroupSchema = z.object({
  id: z.string(),
  at: z.number(),
  line: z.string(),
  lineCodes: NeoStatusCodesSchema,
  notices: z.array(NeoSessionNoticeSchema).max(NEO_SESSION_GROUP_NOTICES_MAX),
});
export const NEO_SESSION_GROUP_MS = 60_000;
export const NEO_SESSION_GROUPS_MAX = 10;
const NEO_SESSION_GROUP_LINE_MAX = 5;
const NOTICE_CODES = {
  needs_you: 'notice.session.needsYou',
  failed: 'notice.session.failed',
  finished: 'notice.session.finished',
} as const;
const NOTICE_LINE_EN = {
  'notice.session.needsYou': '{app} · {title} needs you',
  'notice.session.failed': '{app} · {title} failed',
  'notice.session.finished': '{app} · {title} finished',
  'notice.session.needsYou.open': '{app} · {title} needs you · Open',
  'notice.session.failed.open': '{app} · {title} failed · Open',
  'notice.session.finished.open': '{app} · {title} finished · Open',
  'notice.more': '{count} more',
} as const;
const NEO_SESSION_ACTIVE_MS = 24 * 60 * 60_000;

type NeoSessionNoticeKind = NeoSessionNotice['kind'];

export interface NeoListedSession {
  key: string;
  ref: WorkRef;
  title: string;
  status: WorkStatus;
  lastActivityAt: number;
  link?: string;
  remoteLink?: string;
}

export interface NeoSessionSeen {
  listed: string;
  status: WorkStatus;
}

export const neoSessionKey = (ref: WorkRef) => `${ref.adapter}:${ref.daemon ?? ''}:${ref.id}`;

const fingerprint = (session: NeoListedSession) => `${session.status}:${session.lastActivityAt}`;

export const NEO_SESSION_MUTES_MAX = 200;

export function planNeoSessionMutes(
  current: readonly string[],
  key: string,
  muted: boolean
): string[] {
  const rest = current.filter((item) => item !== key);
  return (muted ? [...rest, key] : rest).slice(-NEO_SESSION_MUTES_MAX);
}

export function listNeoWatchedSessions(
  places: readonly PlaceGroup[],
  cards: readonly WorkRef[],
  now: number,
  muted: readonly string[] = []
): NeoListedSession[] {
  const skip = new Set([...cards.map(neoSessionKey), ...muted]);
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
      ...(work.remoteLink ? { remoteLink: work.remoteLink } : {}),
    }))
    .filter((session) => !skip.has(session.key));
}

export function planNeoSessionWatch(
  listed: readonly NeoListedSession[],
  seen: ReadonlyMap<string, NeoSessionSeen>
): { baseline: [string, NeoSessionSeen][]; reads: NeoListedSession[] } {
  return {
    baseline: listed
      .filter((session) => !seen.has(session.key))
      .map((session) => [session.key, { listed: fingerprint(session), status: session.status }]),
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
  if (!detail) return { seen: prior, notice: null };
  const status = detail.status;
  const seen = { listed: fingerprint(session), status };
  const human = detail.lastInputAt != null && now - detail.lastInputAt < NEO_SESSION_HUMAN_MS;
  const kind: NeoSessionNoticeKind | null =
    status === 'needs_you' && prior.status !== 'needs_you'
      ? 'needs_you'
      : status === 'failed' && prior.status !== 'failed'
        ? 'failed'
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
          ...(session.remoteLink ? { remoteLink: session.remoteLink } : {}),
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

export function neoSessionNoticeLine(notices: readonly NeoSessionNotice[]) {
  const shown = notices.slice(0, NEO_SESSION_GROUP_LINE_MAX).map((notice) => ({
    code: `${NOTICE_CODES[notice.kind]}${notice.link ? '.open' : ''}`,
    params: { app: workerEngine(notice.ref.adapter), title: notice.title },
  }));
  const more = notices.length - shown.length;
  const line = neoStatusLine(NOTICE_LINE_EN, [
    ...shown,
    ...(more > 0 ? [{ code: 'notice.more', params: { count: String(more) } }] : []),
  ]);
  return { line: line.status, lineCodes: line.statusCodes };
}

export function neoSessionNoticeGroup(
  notices: readonly NeoSessionNotice[]
): NeoSessionNoticeGroup | null {
  const first = notices[0];
  return first
    ? {
        id: `neo-session-notices:${first.at}:${first.key}`,
        at: first.at,
        ...neoSessionNoticeLine(notices),
        notices: [...notices],
      }
    : null;
}

export function planNeoSessionNoticeGroup(
  open: readonly NeoSessionNotice[],
  added: readonly NeoSessionNotice[],
  now: number
): { open: NeoSessionNotice[]; closed: NeoSessionNoticeGroup[] } {
  const last = open.at(-1);
  const quiet = !!last && now - last.at >= NEO_SESSION_GROUP_MS;
  const pending = quiet ? [...added] : [...open, ...added];
  const full: NeoSessionNotice[][] = quiet ? [[...open]] : [];
  while (pending.length > NEO_SESSION_GROUP_NOTICES_MAX)
    full.push(pending.splice(0, NEO_SESSION_GROUP_NOTICES_MAX));
  return {
    open: pending,
    closed: full.flatMap((notices) => neoSessionNoticeGroup(notices) ?? []),
  };
}

export function savedNeoSessionNoticeGroups(rows: readonly unknown[]): NeoSessionNoticeGroup[] {
  return rows.flatMap((row) => {
    const parsed = NeoSessionNoticeGroupSchema.safeParse(
      (row as { group?: unknown } | null)?.group
    );
    return parsed.success ? [parsed.data] : [];
  });
}

export function latestNeoSessionNoticeGroups(
  groups: readonly NeoSessionNoticeGroup[]
): NeoSessionNoticeGroup[] {
  const shown = new Set<string>();
  return groups
    .toReversed()
    .flatMap((group) => {
      const notices = group.notices
        .toReversed()
        .filter((notice) => !shown.has(notice.key) && !!shown.add(notice.key))
        .filter((notice) => notice.kind !== 'finished')
        .toReversed();
      if (!notices.length) return [];
      return notices.length === group.notices.length
        ? [group]
        : [{ ...group, ...neoSessionNoticeLine(notices), notices }];
    })
    .toReversed();
}

export function keepNeoSessionNoticeGroups(
  kept: readonly NeoSessionNoticeGroup[],
  closed: NeoSessionNoticeGroup | null
): NeoSessionNoticeGroup[] {
  return closed ? [...kept, closed].slice(-NEO_SESSION_GROUPS_MAX) : [...kept];
}
