import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPublicConversation } from './public-conversation.ts';
import { publicationConversationId } from './useNeoPublications.ts';

type HolderScope = { conversation: NeoPublicConversation; sessionId: string; root: string };

export function admitNeoPublicHolderScope(
  conversation: NeoPublicConversation,
  snapshot: NeoSnapshot | null,
  sessionId: string | null
): { value: HolderScope } | { reason: NeoPublicConversation } {
  const root = snapshot?.sessionId;
  const id = publicationConversationId(root ?? null);
  const unavailable: NeoPublicConversation = {
    conversationId: id,
    status: 'unavailable',
    entries: [],
    hasEarlier: false,
    hasMore: false,
  };
  if (!snapshot || !root || !id || !sessionId || conversation.conversationId !== id)
    return { reason: unavailable };
  if (sessionId === root) return { value: { conversation, sessionId, root } };
  const concerns = new Set(
    (snapshot.publicAuthorBindings ?? [])
      .filter((binding) => binding.kind === 'concern' && binding.sessionId === sessionId)
      .map((binding) => binding.concernId)
  );
  if (
    concerns.size !== 1 ||
    !snapshot.concerns.some((concern) => concerns.has(concern.id)) ||
    snapshot.work.some((work) => work.sessionId === sessionId)
  )
    return { reason: unavailable };
  return { value: { conversation, sessionId, root } };
}

export function presentNeoPublicHolderConversation({
  conversation,
  sessionId,
  root,
}: HolderScope): NeoPublicConversation {
  if (sessionId === root) return conversation;
  const origins = new Set<string>();
  const publications = new Set<string>();
  const originKey = (origin: { sessionId: string; messageId: string }) =>
    JSON.stringify([origin.sessionId, origin.messageId]);
  for (const entry of conversation.entries) {
    if (entry.kind !== 'publication') continue;
    if (
      entry.publication.producerInput.sessionId === sessionId ||
      entry.publication.askOrigin.sessionId === sessionId
    ) {
      publications.add(entry.key);
      origins.add(originKey(entry.publication.askOrigin));
    }
  }
  return {
    ...conversation,
    entries: conversation.entries.filter((entry) =>
      entry.kind === 'publication'
        ? publications.has(entry.key)
        : entry.ask.askOrigin.sessionId === sessionId || origins.has(originKey(entry.ask.askOrigin))
    ),
  };
}

export const projectNeoPublicHolderConversation = (
  superpipe({})('neo-public-holder-conversation') as PipelineAPI
)
  .input(['conversation', 'snapshot', 'sessionId'])
  .pipe(admitNeoPublicHolderScope, ['conversation', 'snapshot', 'sessionId'], 'result:scope')
  .pipe(presentNeoPublicHolderConversation, 'scope', 'scope')
  .end('scope') as (
  conversation: NeoPublicConversation,
  snapshot: NeoSnapshot | null,
  sessionId: string | null
) => NeoPublicConversation;
