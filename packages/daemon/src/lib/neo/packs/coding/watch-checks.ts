import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { requireClosedPrEvent } from '../../../external-events/session-subscription-close.ts';
import type { ExternalEvent } from '../../../external-events/types.ts';
import {
  buildPrEventTopicPattern,
  parseGitHubRefUrl,
  parsePrUrl,
} from '../../../github/parse-pr-url.ts';
import type { NeoRef, NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import type { NeoAskTick } from './issue-checks.ts';

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
    !!item.watch?.length && !item.removed && (item.state === 'pending' || item.state === 'reported')
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

type NeoWatchState = NeoRefState & { event?: string };

function settledAs(state: NeoWatchState): string | null {
  if (state.kind === 'pr')
    return state.state === 'MERGED'
      ? `merged${state.event ? ` (event ${state.event})` : ''}`
      : null;
  if (state.state !== 'CLOSED') return null;
  if (state.done) return `closed as completed${state.closedBy ? ` by ${state.closedBy}` : ''}`;
  return state.duplicate ? 'closed as a duplicate' : 'closed as not planned';
}

export function judgeNeoWatchTicks(ask: NeoAsk, states: readonly NeoWatchState[]): NeoAskTick[] {
  const byKey = new Map(states.map((state) => [refKey(state.url), state]));
  return (ask.doneItems ?? []).filter(isNeoWatchItem).flatMap((item) => {
    const watched = [...new Map(item.watch!.map((url) => [refKey(url), url])).values()];
    const read = watched.map((url) => {
      const state = byKey.get(refKey(url));
      return state ? { url: state.url, settled: settledAs(state) } : null;
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
  now: number
): Promise<NeoAskTick[]> {
  const refs = neoWatchRefs(ask);
  if (!refs.length || now - (lastRead.get(ask.id) ?? -Infinity) < NEO_WATCH_READ_MS) return [];
  lastRead.set(ask.id, now);
  return judgeNeoWatchTicks(ask, await readRefStates(refs));
}

export function neoWatchTopics(ask: NeoAsk): string[] {
  return neoWatchRefs(ask).flatMap((ref) => {
    const parsed = parsePrUrl(`https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`);
    return parsed ? [buildPrEventTopicPattern(parsed)] : [];
  });
}

export function neoWatchEventState(event: ExternalEvent): NeoWatchState | null {
  const closed = requireClosedPrEvent({
    record: { event, state: 'published', createdAt: 0, updatedAt: 0 },
  });
  if (!('value' in closed)) return null;
  const { owner, repo, prNumber } = closed.value;
  const merged = event.payload.merged === true;
  return {
    url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
    kind: 'pr',
    state: merged ? 'MERGED' : 'CLOSED',
    at: event.occurredAt,
    done: merged,
    closedBy: null,
    event: event.id,
  };
}

export async function readNeoWatchEventTicks(
  ask: NeoAsk,
  event: ExternalEvent,
  readRefStates: NeoRefStateReader
): Promise<NeoAskTick[]> {
  const settled = neoWatchEventState(event);
  if (!settled) return [];
  const key = refKey(settled.url);
  const refs = neoWatchRefs(ask);
  const own = (ref: NeoRef) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() === key;
  if (!refs.some(own)) return [];
  const others = refs.filter((ref) => !own(ref));
  const read = others.length ? await readRefStates(others) : [];
  return judgeNeoWatchTicks(ask, [settled, ...read.filter((state) => refKey(state.url) !== key)]);
}
