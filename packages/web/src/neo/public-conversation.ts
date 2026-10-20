import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { NeoSessionNoticeGroup } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskItem } from './conversation-ask-client.ts';
import type { NeoAskState } from './useNeoConversationAsks.ts';
import { publicationConversationId, type NeoPublicationState } from './useNeoPublications.ts';

export type NeoPublicEntry =
  | { kind: 'ask'; key: string; ask: NeoAskItem }
  | {
      kind: 'publication';
      key: string;
      publication: NeoPublication;
      replyTo: NeoAskItem | null;
    }
  | { kind: 'notices'; key: string; group: NeoSessionNoticeGroup }
  | { kind: 'session'; key: string; message: NeoSessionMessage };
export type NeoPublicConversation = {
  conversationId: string | null;
  status: 'loading' | 'ready' | 'unavailable';
  entries: readonly NeoPublicEntry[];
  hasEarlier: boolean;
  hasMore: boolean;
};
type Sources = {
  asks: NeoAskState;
  publications: NeoPublicationState;
  noticeGroups?: readonly NeoSessionNoticeGroup[];
  sessionMessages?: readonly NeoSessionMessage[];
};
type Gate = { value: Sources } | { reason: NeoPublicConversation };

export function neoPublicationAnswerOrigins(publication: NeoPublication) {
  return [
    publication.askOrigin,
    publication.producerInput,
    ...(publication.answerOrigin ? [publication.answerOrigin] : []),
    ...(publication.answerInput ? [publication.answerInput] : []),
    ...(publication.revisions?.flatMap((revision) => [
      revision.producerInput,
      ...(revision.askOrigin ? [revision.askOrigin] : []),
    ]) ?? []),
  ].filter((origin) => !!origin);
}

function empty(conversationId: string | null): NeoPublicConversation {
  return {
    conversationId,
    status: 'unavailable',
    entries: [],
    hasEarlier: false,
    hasMore: false,
  };
}

export function admitNeoPublicSources(
  rootSessionId: string | null,
  asks: NeoAskState,
  publications: NeoPublicationState,
  noticeGroups?: readonly NeoSessionNoticeGroup[],
  sessionMessages?: readonly NeoSessionMessage[]
): Gate {
  const id = publicationConversationId(rootSessionId);
  return id && asks.conversationId === id && publications.conversationId === id
    ? { value: { asks, publications, noticeGroups, sessionMessages } }
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
  noticeGroups = [],
  sessionMessages = [],
}: Sources): NeoPublicConversation {
  const originKey = (origin: NeoAskItem['askOrigin']) =>
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
  const at = (entry: NeoPublicEntry) =>
    entry.kind === 'notices'
      ? entry.group.at
      : Date.parse(
          (entry.kind === 'ask'
            ? entry.ask
            : entry.kind === 'session'
              ? entry.message
              : entry.publication
          ).createdAt
        );
  const sequence = (entry: NeoPublicEntry) =>
    entry.kind === 'ask'
      ? entry.ask.sequence
      : entry.kind === 'publication'
        ? entry.publication.sequence
        : entry.kind === 'session'
          ? entry.message.sequence
          : 0;
  const from =
    asks.hasEarlier || publications.hasEarlier ? Math.min(...entries.map(at)) : -Infinity;
  entries.push(
    ...noticeGroups
      .filter((group) => group.at >= from)
      .map(
        (group): NeoPublicEntry => ({
          kind: 'notices',
          key: JSON.stringify([asks.conversationId, 'notices', group.id]),
          group,
        })
      ),
    ...sessionMessages
      .filter((message) => Date.parse(message.createdAt) >= from)
      .map(
        (message): NeoPublicEntry => ({
          kind: 'session',
          key: JSON.stringify([asks.conversationId, 'session', message.messageId]),
          message,
        })
      )
  );
  const rank = { ask: 0, publication: 1, notices: 2, session: 3 };
  entries.sort(
    (a, b) =>
      at(a) - at(b) ||
      (a.kind === b.kind ? sequence(a) - sequence(b) : rank[a.kind] - rank[b.kind]) ||
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
  .input(['rootSessionId', 'asks', 'publications', 'noticeGroups', 'sessionMessages'])
  .pipe(
    admitNeoPublicSources,
    ['rootSessionId', 'asks', 'publications', 'noticeGroups', 'sessionMessages'],
    'result:conversation'
  )
  .pipe(requireNeoPublicIdentities, 'conversation', 'result:conversation')
  .pipe(presentNeoPublicConversation, 'conversation', 'conversation')
  .end('conversation') as (
  rootSessionId: string | null,
  asks: NeoAskState,
  publications: NeoPublicationState,
  noticeGroups?: readonly NeoSessionNoticeGroup[],
  sessionMessages?: readonly NeoSessionMessage[]
) => NeoPublicConversation;
