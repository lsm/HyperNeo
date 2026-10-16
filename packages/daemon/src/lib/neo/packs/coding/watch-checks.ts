import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { ExternalEvent } from '../../../external-events/types.ts';
import {
  buildPrEventTopicPattern,
  parseGitHubRefUrl,
  parseGitHubTopic,
  parsePrUrl,
} from '../../../github/parse-pr-url.ts';
import type { NeoRef, NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import { CODING_CHECK_DEPLOYED } from './deploy-checks.ts';
import type { NeoAskTick } from './issue-checks.ts';

export const CODING_CHECK_PR_MERGED = 'coding.pr_merged';
type NeoCardStartedAt = (workId: string) => number | null;
type NeoCardBase = (workId: string) => string | null;
type NeoCardPrs = (workId: string) => readonly Pick<NeoWorkPr, 'url' | 'state'>[];
const noCardPrs: NeoCardPrs = () => [];

export function codingCardBase(target: { verb: string; preparationParameters?: unknown } | null) {
  const base =
    target?.verb === 'start'
      ? (target.preparationParameters as { target?: unknown } | undefined)?.target
      : null;
  return typeof base === 'string' && base !== 'HEAD' ? base : null;
}

const NEO_WATCH_READ_MS = 2 * 60_000;
export const NEO_ASK_WATCH_MAX = 20;
const lastRead = new Map<string, number>();
const lastMerged = new Map<string, string>();

function refKey(url: string): string {
  const ref = parseGitHubRefUrl(url);
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : url.toLowerCase();
}

export function countNeoAskWatches(items: readonly Pick<NeoAskItem, 'watch'>[]): number {
  return new Set(items.flatMap((item) => item.watch ?? []).map(refKey)).size;
}

export function neoItemWatchUrls(
  item: Pick<NeoAskItem, 'watch' | 'check' | 'deliveredBy'>,
  cardPrs: NeoCardPrs
): string[] {
  if (item.watch?.length) return item.watch;
  return item.check === CODING_CHECK_PR_MERGED && item.deliveredBy
    ? cardPrs(item.deliveredBy).map((pr) => pr.url)
    : [];
}

export function isNeoWatchItem(item: NeoAskItem, cardPrs: NeoCardPrs = noCardPrs): boolean {
  return (
    !!neoItemWatchUrls(item, cardPrs).length &&
    item.check !== CODING_CHECK_DEPLOYED &&
    !item.removed &&
    (item.state === 'pending' || item.state === 'reported')
  );
}

function watchedUrls(ask: NeoAsk, cardPrs: NeoCardPrs): string[] {
  return (ask.doneItems ?? [])
    .filter((item) => isNeoWatchItem(item, cardPrs))
    .flatMap((item) => neoItemWatchUrls(item, cardPrs));
}

export function neoCardMergedKey(ask: NeoAsk, cardPrs: NeoCardPrs): string {
  return (ask.doneItems ?? [])
    .filter((item) => !item.watch?.length && isNeoWatchItem(item, cardPrs))
    .flatMap((item) => cardPrs(item.deliveredBy!).filter((pr) => pr.state === 'MERGED'))
    .map((pr) => refKey(pr.url))
    .sort()
    .join(' ');
}

export function neoWatchRefs(ask: NeoAsk, cardPrs: NeoCardPrs = noCardPrs): NeoRef[] {
  const refs = new Map<string, NeoRef>();
  for (const url of watchedUrls(ask, cardPrs)) {
    const ref = parseGitHubRefUrl(url);
    if (ref) refs.set(refKey(url), ref);
  }
  return [...refs.values()].slice(0, NEO_ASK_WATCH_MAX);
}

function settledAs(
  state: NeoRefState,
  item: NeoAskItem,
  cardBase: NeoCardBase,
  since: number | null
): string | null {
  if (state.kind === 'pr' && state.state !== 'MERGED') return null;
  if (state.kind === 'issue' && (state.state !== 'CLOSED' || !state.done)) return null;
  const merged = state.kind === 'pr' ? 'merged' : `closed as completed by ${state.closedBy}`;
  if (
    state.kind === 'pr' &&
    (since === null ||
      !Number.isFinite(since) ||
      state.at === null ||
      !Number.isFinite(state.at) ||
      state.at <= since)
  )
    return null;
  if (item.check !== CODING_CHECK_PR_MERGED)
    return state.kind === 'pr' || state.closedBy ? merged : 'closed as completed';
  if (since === null || !Number.isFinite(since)) return null;
  if (!item.deliveredBy && state.kind === 'pr') return merged;
  const required = (item.deliveredBy ? cardBase(item.deliveredBy) : null) ?? state.defaultBase;
  if (!required) return null;
  if (state.kind === 'pr') return state.base === required ? `merged into ${required}` : null;
  const landed = (state.merges ?? []).find(
    (merge) => merge.base === required && merge.at != null && merge.at > since
  );
  return landed ? `closed as completed by ${landed.url} into ${required}` : null;
}

export function judgeNeoWatchTicks(
  ask: NeoAsk,
  states: readonly NeoRefState[],
  cardBase: NeoCardBase = () => null,
  cardPrs: NeoCardPrs = noCardPrs,
  cardStartedAt: NeoCardStartedAt = () => null
): NeoAskTick[] {
  const byKey = new Map(states.map((state) => [refKey(state.url), state]));
  return (ask.doneItems ?? [])
    .filter((item) => isNeoWatchItem(item, cardPrs))
    .flatMap((item) => {
      const watched = [
        ...new Map(neoItemWatchUrls(item, cardPrs).map((url) => [refKey(url), url])).values(),
      ];
      const starts = (item.deliveredBy ? [item.deliveredBy] : ask.workIds)
        .map(cardStartedAt)
        .filter((at): at is number => at !== null && Number.isFinite(at));
      const since =
        item.deliveredBy || ask.workIds.length
          ? starts.length
            ? Math.min(...starts)
            : null
          : ask.createdAt;
      const read = watched.map((url) => {
        const state = byKey.get(refKey(url));
        return state
          ? {
              url: state.url,
              settled: settledAs(state, item, cardBase, since),
            }
          : null;
      });
      if (read.some((entry) => !entry?.settled)) return [];
      return [
        {
          id: item.id,
          evidence: `Watched: ${read.map((entry) => `${entry!.url} ${entry!.settled}`).join('; ')}`,
        },
      ];
    });
}

export async function readNeoWatchTicks(
  ask: NeoAsk,
  readRefStates: NeoRefStateReader,
  now: number,
  cardBase?: NeoCardBase,
  cardPrs: NeoCardPrs = noCardPrs,
  cardStartedAt?: NeoCardStartedAt
): Promise<NeoAskTick[]> {
  const refs = neoWatchRefs(ask, cardPrs);
  const merged = neoCardMergedKey(ask, cardPrs);
  const fresh = !!merged && merged !== lastMerged.get(ask.id);
  if (!refs.length || (!fresh && now - (lastRead.get(ask.id) ?? -Infinity) < NEO_WATCH_READ_MS))
    return [];
  lastRead.set(ask.id, now);
  if (merged) lastMerged.set(ask.id, merged);
  return judgeNeoWatchTicks(ask, await readRefStates(refs), cardBase, cardPrs, cardStartedAt);
}

export function neoWatchTopics(ask: NeoAsk, cardPrs: NeoCardPrs = noCardPrs): string[] {
  const urls = watchedUrls(ask, cardPrs);
  const topics = urls.flatMap((url) => {
    const pr = parsePrUrl(url);
    return pr && pr.host.toLowerCase() === 'github.com' ? [buildPrEventTopicPattern(pr)] : [];
  });
  return [...new Set(topics)];
}

export function neoWatchEventMerge(event: ExternalEvent): NeoRefState | null {
  const topic = parseGitHubTopic(event.topic);
  if (topic?.resource !== 'pull_request' || event.payload.merged !== true) return null;
  return {
    url: `https://github.com/${topic.owner}/${topic.repo}/pull/${topic.entity}`,
    kind: 'pr',
    state: 'MERGED',
    at: event.occurredAt,
    done: true,
    closedBy: null,
  };
}

export async function readNeoWatchEventTicks(
  ask: NeoAsk,
  event: ExternalEvent,
  readRefStates: NeoRefStateReader,
  cardBase?: NeoCardBase,
  cardPrs: NeoCardPrs = noCardPrs,
  cardStartedAt?: NeoCardStartedAt
): Promise<NeoAskTick[]> {
  const merge = neoWatchEventMerge(event);
  if (!merge) return [];
  const items = (ask.doneItems ?? []).filter(
    (item) =>
      isNeoWatchItem(item, cardPrs) &&
      neoItemWatchUrls(item, cardPrs).some((url) => refKey(url) === refKey(merge.url))
  );
  if (!items.length) return [];
  const urls = items.flatMap((item) => neoItemWatchUrls(item, cardPrs));
  const others = new Map<string, NeoRef>();
  for (const url of urls) {
    const ref = parseGitHubRefUrl(url);
    if (ref) others.set(refKey(url), ref);
  }
  const states = others.size ? await readRefStates([...others.values()]) : [];
  const ids = new Set(items.map((item) => item.id));
  return judgeNeoWatchTicks(ask, states, cardBase, cardPrs, cardStartedAt)
    .filter((tick) => ids.has(tick.id))
    .map((tick) => ({
      ...tick,
      evidence: `${tick.evidence} (event ${event.id}: ${event.summary})`,
    }));
}
