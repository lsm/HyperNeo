import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
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
type NeoCardBase = (workId: string) => string | null;

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

function refKey(url: string): string {
  const ref = parseGitHubRefUrl(url);
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : url.toLowerCase();
}

export function countNeoAskWatches(items: readonly Pick<NeoAskItem, 'watch'>[]): number {
  return new Set(items.flatMap((item) => item.watch ?? []).map(refKey)).size;
}

export function isNeoWatchItem(item: NeoAskItem): boolean {
  return (
    !!item.watch?.length &&
    item.check !== CODING_CHECK_DEPLOYED &&
    !item.removed &&
    (item.state === 'pending' || item.state === 'reported')
  );
}

export function neoWatchRefs(ask: NeoAsk): NeoRef[] {
  const refs = new Map<string, NeoRef>();
  for (const url of (ask.doneItems ?? []).filter(isNeoWatchItem).flatMap((item) => item.watch!)) {
    const ref = parseGitHubRefUrl(url);
    if (ref) refs.set(refKey(url), ref);
  }
  return [...refs.values()].slice(0, NEO_ASK_WATCH_MAX);
}

function settledAs(state: NeoRefState, item: NeoAskItem, cardBase: NeoCardBase): string | null {
  if (state.kind === 'pr' && state.state !== 'MERGED') return null;
  if (state.kind === 'issue' && (state.state !== 'CLOSED' || !state.done)) return null;
  const merged = state.kind === 'pr' ? 'merged' : `closed as completed by ${state.closedBy}`;
  if (item.check !== CODING_CHECK_PR_MERGED)
    return state.kind === 'pr' || state.closedBy ? merged : 'closed as completed';
  if (state.kind === 'issue' && !state.closedBy) return null;
  if (!item.deliveredBy) return merged;
  const required = cardBase(item.deliveredBy) ?? state.defaultBase;
  return required && state.base === required ? `${merged} into ${required}` : null;
}

export function judgeNeoWatchTicks(
  ask: NeoAsk,
  states: readonly NeoRefState[],
  cardBase: NeoCardBase = () => null
): NeoAskTick[] {
  const byKey = new Map(states.map((state) => [refKey(state.url), state]));
  return (ask.doneItems ?? []).filter(isNeoWatchItem).flatMap((item) => {
    const watched = [...new Map(item.watch!.map((url) => [refKey(url), url])).values()];
    const read = watched.map((url) => {
      const state = byKey.get(refKey(url));
      return state ? { url: state.url, settled: settledAs(state, item, cardBase) } : null;
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
  cardBase?: NeoCardBase
): Promise<NeoAskTick[]> {
  const refs = neoWatchRefs(ask);
  if (!refs.length || now - (lastRead.get(ask.id) ?? -Infinity) < NEO_WATCH_READ_MS) return [];
  lastRead.set(ask.id, now);
  return judgeNeoWatchTicks(ask, await readRefStates(refs), cardBase);
}

export function neoWatchTopics(ask: NeoAsk): string[] {
  const urls = (ask.doneItems ?? []).filter(isNeoWatchItem).flatMap((item) => item.watch!);
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
  cardBase?: NeoCardBase
): Promise<NeoAskTick[]> {
  const merge = neoWatchEventMerge(event);
  if (!merge) return [];
  const items = (ask.doneItems ?? []).filter(
    (item) => isNeoWatchItem(item) && item.watch!.some((url) => refKey(url) === refKey(merge.url))
  );
  if (!items.length) return [];
  const watched = items
    .flatMap((item) => item.watch!)
    .find((url) => refKey(url) === refKey(merge.url));
  const merged = { ...merge, url: watched ?? merge.url };
  const others = new Map<string, NeoRef>();
  for (const url of items.flatMap((item) => item.watch!)) {
    const ref = parseGitHubRefUrl(url);
    if (ref && refKey(url) !== refKey(merge.url)) others.set(refKey(url), ref);
  }
  const states = others.size ? await readRefStates([...others.values()]) : [];
  const ids = new Set(items.map((item) => item.id));
  return judgeNeoWatchTicks(ask, [...states, merged], cardBase)
    .filter((tick) => ids.has(tick.id))
    .map((tick) => ({
      ...tick,
      evidence: `${tick.evidence} (event ${event.id}: ${event.summary})`,
    }));
}
