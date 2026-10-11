import type { NeoSessionNotice, NeoSessionNoticeGroup } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { type PlaceGroup, type WorkRef, WorkRefSchema, type WorkStatus } from '../drivers/types.ts';

export type { NeoSessionNotice, NeoSessionNoticeGroup };

export const NEO_SESSION_RUN_MS = 3 * 60_000;
const NEO_SESSION_HUMAN_MS = 2 * 60_000;
export const NEO_SESSION_NOTICES_MAX = 20;
export const NEO_SESSION_WATCH_LIMIT = 30;
export const NEO_SESSION_GROUP_NOTICES_MAX = 30;
export const NeoSessionNoticeSchema = z.object({
  key: z.string(),
  ref: WorkRefSchema,
  title: z.string(),
  kind: z.enum(['needs_you', 'failed', 'finished']),
  at: z.number(),
  link: z.string().optional(),
});
export const NeoSessionNoticeGroupSchema = z.object({
  id: z.string(),
  at: z.number(),
  line: z.string(),
  notices: z.array(NeoSessionNoticeSchema).max(NEO_SESSION_GROUP_NOTICES_MAX),
});
export const NEO_SESSION_GROUP_MS = 60_000;
export const NEO_SESSION_GROUPS_MAX = 10;
const NEO_SESSION_GROUP_LINE_MAX = 5;
const ADAPTER_LABELS: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'Space',
  'codex-desktop': 'Codex',
  'claude-desktop': 'Claude',
  'claude-code': 'Claude Code',
};
const KIND_LABELS: Record<NeoSessionNotice['kind'], string> = {
  needs_you: 'needs you',
  failed: 'failed',
  finished: 'finished',
};
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
  if (!detail) return { seen: prior, notice: null };
  const status = detail.status;
  const seen = {
    listed: fingerprint(session),
    status,
    runningSince: status === 'running' ? (prior.runningSince ?? now) : null,
  };
  const human = detail.lastInputAt != null && now - detail.lastInputAt < NEO_SESSION_HUMAN_MS;
  const kind: NeoSessionNoticeKind | null =
    status === 'needs_you' && prior.status !== 'needs_you'
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

export function neoSessionNoticeLine(notices: readonly NeoSessionNotice[]): string {
  const shown = notices
    .slice(0, NEO_SESSION_GROUP_LINE_MAX)
    .map((notice) =>
      [
        ADAPTER_LABELS[notice.ref.adapter] ?? notice.ref.adapter,
        `${notice.title} ${KIND_LABELS[notice.kind]}`,
        ...(notice.link ? ['Open'] : []),
      ].join(' · ')
    );
  const more = notices.length - shown.length;
  return [...shown, ...(more > 0 ? [`${more} more`] : [])].join('; ');
}

export function neoSessionNoticeGroup(
  notices: readonly NeoSessionNotice[]
): NeoSessionNoticeGroup | null {
  const first = notices[0];
  return first
    ? {
        id: `neo-session-notices:${first.at}:${first.key}`,
        at: first.at,
        line: neoSessionNoticeLine(notices),
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

export function keepNeoSessionNoticeGroups(
  kept: readonly NeoSessionNoticeGroup[],
  closed: NeoSessionNoticeGroup | null
): NeoSessionNoticeGroup[] {
  return closed ? [...kept, closed].slice(-NEO_SESSION_GROUPS_MAX) : [...kept];
}
