import type { NeoAsk, NeoAskSessionView } from '@hyperneo/shared/types/neo-snapshot';
import { keepOpenedPrs } from '../drivers/opened-prs.ts';
import type { WorkStatus } from '../drivers/types.ts';
import { githubUrlKey } from '../github/parse-pr-url.ts';
import { neoSessionOpenTarget } from './card-views.ts';
import type { NeoEvidence } from './evidence.ts';
import { extractNeoAskRefs } from './packs/coding/ask-prs.ts';
import type { NeoListedSession, NeoSessionNotice } from './session-watch.ts';

export const NEO_SESSION_PR_READS_MAX = 10;
export const NEO_SESSION_PR_RECHECK_MS = 10 * 60_000;
const LINKED_ASKS: ReadonlySet<NeoAsk['status']> = new Set(['open', 'waiting', 'blocked']);

export type NeoSessionAskLink = { askId: string; key: string };
export type NeoAskPrs = { id: string; status: NeoAsk['status']; prs: ReadonlySet<string> };

const needsHuman = (status: WorkStatus) => status === 'needs_you' || status === 'failed';

export function planNeoSessionPrReads(
  listed: readonly NeoListedSession[],
  known: ReadonlyMap<string, readonly string[]>,
  reading: readonly NeoListedSession[],
  checkedAt: ReadonlyMap<string, number>,
  now: number
): NeoListedSession[] {
  const read = new Set(reading.map((session) => session.key));
  const rank = (session: NeoListedSession) => (needsHuman(session.status) ? 0 : 1);
  const due = (key: string) =>
    !known.has(key) ||
    (!known.get(key)?.length && now - (checkedAt.get(key) ?? 0) >= NEO_SESSION_PR_RECHECK_MS);
  return listed
    .filter((session) => due(session.key) && !read.has(session.key))
    .sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
    .slice(0, NEO_SESSION_PR_READS_MAX);
}

export function keepNeoSessionPrs(
  known: ReadonlyMap<string, readonly string[]>,
  found: ReadonlyMap<string, readonly string[]>
): Map<string, string[]> {
  const kept = new Map([...known].map(([key, urls]) => [key, [...urls]]));
  for (const [key, urls] of found)
    kept.set(key, keepOpenedPrs([...(kept.get(key) ?? []), ...urls]));
  return kept;
}

export function neoAskPrKeys(
  ask: Pick<NeoAsk, 'ask' | 'doneWhen' | 'outcome' | 'evidence' | 'doneItems'>,
  evidence: readonly NeoEvidence[]
): Set<string> {
  const tracked = evidence.map((item) => item.key).filter((key) => /^https?:\/\//.test(key));
  const named = extractNeoAskRefs(ask, tracked).map(
    (ref) => `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`
  );
  const watched = (ask.doneItems ?? []).flatMap((item) =>
    item.removed ? [] : (item.watch ?? []).filter((url) => /\/pull\/\d+/.test(url))
  );
  return new Set([...tracked, ...named, ...watched].map(githubUrlKey));
}

export function linkNeoSessionsToAsks(
  asks: readonly NeoAskPrs[],
  sessions: ReadonlyMap<string, readonly string[]>
): NeoSessionAskLink[] {
  return asks
    .filter((ask) => LINKED_ASKS.has(ask.status))
    .flatMap((ask) =>
      [...sessions]
        .filter(([, urls]) => urls.some((url) => ask.prs.has(githubUrlKey(url))))
        .map(([key]) => ({ askId: ask.id, key }))
    );
}

export function describeNeoAskSessions(
  links: readonly NeoSessionAskLink[],
  sessions: readonly NeoListedSession[],
  statusOf: (session: NeoListedSession) => WorkStatus
): Map<string, NeoAskSessionView[]> {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const views = new Map<string, NeoAskSessionView[]>();
  for (const link of links) {
    const session = byKey.get(link.key);
    if (!session) continue;
    const status = statusOf(session);
    views.set(link.askId, [
      ...(views.get(link.askId) ?? []),
      {
        key: session.key,
        title: session.title,
        adapter: session.ref.adapter,
        status,
        kind: status === 'needs_you' || status === 'failed' ? status : null,
        open: neoSessionOpenTarget(session),
      },
    ]);
  }
  return views;
}

export function planNeoHeldSessionNotices(
  held: ReadonlyMap<string, NeoSessionNotice>,
  planned: readonly NeoSessionNotice[],
  linked: ReadonlySet<string>,
  statusOf: (key: string) => WorkStatus | undefined
): { notices: NeoSessionNotice[]; held: Map<string, NeoSessionNotice> } {
  const next = new Map(
    [...held].filter(([key, notice]) => statusOf(key) === notice.kind && linked.has(key))
  );
  const released = [...held.values()].filter(
    (notice) => statusOf(notice.key) === notice.kind && !linked.has(notice.key)
  );
  for (const notice of planned) if (linked.has(notice.key)) next.set(notice.key, notice);
  const fresh = planned.filter((notice) => !linked.has(notice.key));
  const posted = new Set(fresh.map((notice) => notice.key));
  return {
    notices: [...released.filter((notice) => !posted.has(notice.key)), ...fresh],
    held: next,
  };
}

export function unmutedNeoAskSessions(
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]>,
  muted: readonly string[]
): Map<string, NeoAskSessionView[]> {
  const off = new Set(muted);
  return new Map(
    [...sessions].map(([askId, list]) => [askId, list.filter((item) => !off.has(item.key))])
  );
}

export function busyNeoAskSessions(
  sessions: ReadonlyMap<string, readonly NeoAskSessionView[]>
): Set<string> {
  return new Set(
    [...sessions].flatMap(([askId, list]) =>
      list.some((item) => item.status === 'queued' || item.status === 'running') ? [askId] : []
    )
  );
}
