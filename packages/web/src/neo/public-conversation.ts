import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskState } from './useNeoConversationAsks.ts';
import { publicationConversationId, type NeoPublicationState } from './useNeoPublications.ts';

export type NeoPublicEntry =
  | { kind: 'ask'; key: string; ask: NeoConversationAsk }
  | {
      kind: 'publication';
      key: string;
      publication: NeoPublication;
      replyTo: NeoConversationAsk | null;
    };
export type NeoPublicConversation = {
  conversationId: string | null;
  status: 'loading' | 'ready' | 'unavailable';
  entries: readonly NeoPublicEntry[];
  hasEarlier: boolean;
  hasMore: boolean;
};
type Sources = { asks: NeoAskState; publications: NeoPublicationState };
type Gate = { value: Sources } | { reason: NeoPublicConversation };

function empty(conversationId: string | null): NeoPublicConversation {
  return { conversationId, status: 'unavailable', entries: [], hasEarlier: false, hasMore: false };
}

export function admitNeoPublicSources(
  rootSessionId: string | null,
  asks: NeoAskState,
  publications: NeoPublicationState
): Gate {
  const id = publicationConversationId(rootSessionId);
  return id && asks.conversationId === id && publications.conversationId === id
    ? { value: { asks, publications } }
    : { reason: empty(id) };
}

export function requireNeoPublicIdentities(sources: Sources): Gate {
  const id = sources.asks.conversationId;
  const valid = <T extends { conversationId: string; sequence: number; createdAt: string }>(
    items: readonly T[],
    identity: (item: T) => string
  ) => {
    const ids = new Set<string>();
    const sequences = new Set<number>();
    return (
      items.length <= 500 &&
      items.every((item) => {
        const key = identity(item);
        if (
          !key ||
          item.conversationId !== id ||
          !Number.isSafeInteger(item.sequence) ||
          item.sequence < 1 ||
          !Number.isFinite(Date.parse(item.createdAt)) ||
          ids.has(key) ||
          sequences.has(item.sequence)
        )
          return false;
        ids.add(key);
        sequences.add(item.sequence);
        return true;
      })
    );
  };
  return valid(sources.asks.items, (ask) =>
    ask.requestId === ask.askOrigin.messageId ? ask.requestId : ''
  ) && valid(sources.publications.items, (publication) => publication.publicationId)
    ? { value: sources }
    : { reason: empty(id) };
}

export function presentNeoPublicConversation({
  asks,
  publications,
}: Sources): NeoPublicConversation {
  const originKey = (origin: NeoConversationAsk['askOrigin']) =>
    JSON.stringify([origin.sessionId, origin.messageId]);
  const origins = new Map(asks.items.map((ask) => [originKey(ask.askOrigin), ask]));
  const entries: NeoPublicEntry[] = [
    ...asks.items.map(
      (ask): NeoPublicEntry => ({
        kind: 'ask',
        key: JSON.stringify([ask.conversationId, 'ask', ask.requestId]),
        ask,
      })
    ),
    ...publications.items.map(
      (publication): NeoPublicEntry => ({
        kind: 'publication',
        key: JSON.stringify([publication.conversationId, 'publication', publication.publicationId]),
        publication,
        replyTo: origins.get(originKey(publication.askOrigin)) ?? null,
      })
    ),
  ];
  const payload = (entry: NeoPublicEntry) => (entry.kind === 'ask' ? entry.ask : entry.publication);
  entries.sort(
    (a, b) =>
      Date.parse(payload(a).createdAt) - Date.parse(payload(b).createdAt) ||
      (a.kind === b.kind ? payload(a).sequence - payload(b).sequence : a.kind === 'ask' ? -1 : 1) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  return {
    conversationId: asks.conversationId,
    status:
      asks.status === 'unavailable' || publications.status === 'unavailable'
        ? 'unavailable'
        : asks.status === 'ready' && publications.status === 'ready'
          ? 'ready'
          : 'loading',
    entries,
    hasEarlier: asks.hasEarlier || publications.hasEarlier,
    hasMore: asks.hasMore || publications.hasMore,
  };
}

export const projectNeoPublicConversation = (
  superpipe({})('neo-public-conversation') as PipelineAPI
)
  .input(['rootSessionId', 'asks', 'publications'])
  .pipe(admitNeoPublicSources, ['rootSessionId', 'asks', 'publications'], 'result:conversation')
  .pipe(requireNeoPublicIdentities, 'conversation', 'result:conversation')
  .pipe(presentNeoPublicConversation, 'conversation', 'conversation')
  .end('conversation') as (
  rootSessionId: string | null,
  asks: NeoAskState,
  publications: NeoPublicationState
) => NeoPublicConversation;

export function neoWorkSummaries(
  entries: readonly NeoPublicEntry[] | undefined
): ReadonlyMap<string, { text: string; at: number }> {
  const summaries = new Map<string, { text: string; at: number }>();
  for (const entry of entries ?? []) {
    if (entry.kind !== 'publication') continue;
    const text = entry.publication.shortText.trim() || entry.publication.fullText.trim();
    const at = Date.parse(entry.publication.createdAt);
    for (const link of entry.publication.links)
      if (link.kind === 'work' && text) summaries.set(link.id, { text, at });
  }
  return summaries;
}

export function neoWorkSummary(
  summaries: ReadonlyMap<string, { text: string; at: number }>,
  work: { id: string; updatedAt: number }
): string | undefined {
  const summary = summaries.get(work.id);
  return summary && summary.at >= work.updatedAt ? summary.text : undefined;
}
