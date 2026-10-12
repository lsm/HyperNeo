import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { parseGitHubRefUrl } from '../../../github/parse-pr-url.ts';
import type { NeoRef, NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import type { NeoAskTick } from './issue-checks.ts';

const NEO_WATCH_READ_MS = 2 * 60_000;
const NEO_WATCH_REF_MAX = 20;
const lastRead = new Map<string, number>();

function refKey(url: string): string {
  const ref = parseGitHubRefUrl(url);
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() : url.toLowerCase();
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
  return [...refs.values()].slice(0, NEO_WATCH_REF_MAX);
}

function settledAs(state: NeoRefState): string | null {
  if (state.kind === 'pr') return state.state === 'MERGED' ? 'merged' : null;
  if (state.state !== 'CLOSED') return null;
  if (state.done) return `closed as completed${state.closedBy ? ` by ${state.closedBy}` : ''}`;
  return state.duplicate ? 'closed as a duplicate' : 'closed as not planned';
}

export function judgeNeoWatchTicks(ask: NeoAsk, states: readonly NeoRefState[]): NeoAskTick[] {
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
