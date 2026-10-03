import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPublicConversation } from './public-conversation.ts';
import { publicationConversationId } from './useNeoPublications.ts';

export function admitNeoPublicHolderScope(
  conversation: NeoPublicConversation,
  snapshot: NeoSnapshot | null,
  sessionId: string | null
): { value: NeoPublicConversation } | { reason: NeoPublicConversation } {
  const root = snapshot?.sessionId;
  const id = publicationConversationId(root ?? null);
  if (!snapshot || !root || !id || sessionId !== root || conversation.conversationId !== id)
    return {
      reason: {
        conversationId: id,
        status: 'unavailable',
        entries: [],
        hasEarlier: false,
        hasMore: false,
      },
    };
  return { value: conversation };
}

export const projectNeoPublicHolderConversation = (
  superpipe({})('neo-public-holder-conversation') as PipelineAPI
)
  .input(['conversation', 'snapshot', 'sessionId'])
  .pipe(admitNeoPublicHolderScope, ['conversation', 'snapshot', 'sessionId'], 'result:scope')
  .end('scope') as (
  conversation: NeoPublicConversation,
  snapshot: NeoSnapshot | null,
  sessionId: string | null
) => NeoPublicConversation;
