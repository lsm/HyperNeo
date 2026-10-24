import type { NeoCardReply } from '@hyperneo/shared/types/neo-publication';
import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoConversationWake } from '@hyperneo/shared/types/neo-wake';
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
  | { kind: 'wake'; key: string; wake: NeoConversationWake }
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
  wakes?: readonly NeoConversationWake[];
};
type Gate = { value: Sources } | { reason: NeoPublicConversation };

export function neoPublicationAnswerOrigins(publication: NeoPublication) {
  if (publication.cardReply) return [];
  return [
    publication.askOrigin,
    ...(publication.triggerId?.startsWith('human:') ? [] : [publication.producerInput]),
    ...(publication.answerOrigin ? [publication.answerOrigin] : []),
    ...(publication.answerInput ? [publication.answerInput] : []),
    ...(publication.revisions?.map((revision) => revision.askOrigin ?? revision.producerInput) ??
      []),
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
  sessionMessages?: readonly NeoSessionMessage[],
  wakes?: readonly NeoConversationWake[]
): Gate {
  const id = publicationConversationId(rootSessionId);
  return id && asks.conversationId === id && publications.conversationId === id
    ? { value: { asks, publications, noticeGroups, sessionMessages, wakes } }
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
  wakes = [],
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
        replyTo: publication.askOrigin
          ? (origins.get(originKey(publication.askOrigin)) ?? null)
          : null,
      })
    ),
  ];
  const at = (entry: NeoPublicEntry) =>
    entry.kind === 'wake' || entry.kind === 'notices'
      ? entry.kind === 'wake'
        ? entry.wake.firedAt
        : entry.group.at
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
    ...wakes
      .filter((wake) => wake.firedAt >= from)
      .map(
        (wake): NeoPublicEntry => ({
          kind: 'wake',
          key: JSON.stringify([asks.conversationId, 'wake', wake.scheduleId, wake.firedAt]),
          wake,
        })
      ),
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
  const rank = { ask: 0, publication: 1, notices: 2, session: 3, wake: 4 };
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
  .input(['rootSessionId', 'asks', 'publications', 'noticeGroups', 'sessionMessages', 'wakes'])
  .pipe(
    admitNeoPublicSources,
    ['rootSessionId', 'asks', 'publications', 'noticeGroups', 'sessionMessages', 'wakes'],
    'result:conversation'
  )
  .pipe(requireNeoPublicIdentities, 'conversation', 'result:conversation')
  .pipe(presentNeoPublicConversation, 'conversation', 'conversation')
  .end('conversation') as (
  rootSessionId: string | null,
  asks: NeoAskState,
  publications: NeoPublicationState,
  noticeGroups?: readonly NeoSessionNoticeGroup[],
  sessionMessages?: readonly NeoSessionMessage[],
  wakes?: readonly NeoConversationWake[]
) => NeoPublicConversation;

export function neoCardReplyTitle(publication: NeoPublication, title?: string): string {
  return (
    title ??
    publication.shortText.replace(/^(?:I replied · View card|我给你回了 · 查看卡片)\s*·?\s*/, '')
  )
    .split('\n')[0]
    .slice(0, 120);
}

export const resolveNeoCardReply = (superpipe({})('neo-card-reply-target') as PipelineAPI)
  .input(['reply', 'entries'])
  .pipe(
    (reply: Pick<NeoCardReply, 'askId' | 'questionId'>, entries: readonly NeoAskEntry[]) => {
      const entry = entries.find((entry) => entry.ask.id === reply.askId);
      let question = entry?.questions.find((question) => question.id === reply.questionId);
      const seen = new Set<string>();
      while (question?.replacedBy && !seen.has(question.id)) {
        seen.add(question.id);
        question = entry?.questions.find((next) => next.id === question!.replacedBy);
      }
      return question && !seen.has(question.id)
        ? { value: { askId: reply.askId, questionId: question.id } }
        : { reason: 'unavailable' };
    },
    ['reply', 'entries'],
    'result:target'
  )
  .end('target') as (
  reply: Pick<NeoCardReply, 'askId' | 'questionId'>,
  entries: readonly NeoAskEntry[]
) => { askId: string; questionId: string } | 'unavailable';
