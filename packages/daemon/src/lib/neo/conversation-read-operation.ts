import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoConversationAskPageSchema } from './conversation-ask-read-operation.ts';
import {
  NeoStoredPublicationSchema,
  requirePublicationConversation,
} from './publication-read-operation.ts';
import {
  NeoConversationCursorSchema,
  NeoConversationReadInput,
  type NeoConversationPage,
  type NeoConversationReader,
} from '../../storage/repositories/neo-conversation-reader.ts';

type Rejected = { ok: false; reason: 'reader_not_authorized' | 'conversation_not_found' };
export function requireNeoConversationReader(
  page: NeoConversationPage,
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: NeoConversationPage } | { reason: Rejected } {
  return (caller.source === 'rpc' && caller.principal === 'local') ||
    (caller.source === 'mcp' &&
      caller.role === 'neo' &&
      !!caller.neoTurn?.isLive() &&
      !!binding &&
      binding.sessionId === caller.sessionId &&
      ['neo', 'project'].includes(binding.kind))
    ? { value: page }
    : { reason: { ok: false, reason: 'reader_not_authorized' } };
}

export function createNeoConversationReadOperation(
  repo: NeoRepository,
  ledger: NeoConversationReader
) {
  const read = (superpipe({})('neo-conversation-read') as PipelineAPI)
    .input(['page', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null,
      'caller',
      'binding'
    )
    .pipe(requireNeoConversationReader, ['page', 'caller', 'binding'], 'result:page')
    .pipe(() => repo.conversationId(), 'page', 'conversation')
    .pipe(requirePublicationConversation, ['page', 'conversation'], 'result:page')
    .pipe(
      (page: NeoConversationPage) => ({
        ok: true as const,
        conversationId: page.conversationId,
        ...ledger.read(page),
      }),
      'page',
      'page'
    )
    .end('page') as (
    page: NeoConversationPage,
    caller: OperationCaller
  ) =>
    | Rejected
    | ({
        ok: true;
        conversationId: string;
      } & ReturnType<NeoConversationReader['read']>);
  const resultSchema: z.ZodType<ReturnType<typeof read>> = z.union([
    z.object({
      ok: z.literal(false),
      reason: z.enum(['reader_not_authorized', 'conversation_not_found']),
    }),
    z.object({
      ok: z.literal(true),
      conversationId: z.uuid(),
      items: z.array(
        z.discriminatedUnion('role', [
          z.object({
            role: z.literal('human'),
            cursor: NeoConversationCursorSchema,
            ask: NeoConversationAskPageSchema.extend({
              content: NeoConversationAskPageSchema.shape.content.readonly(),
            }),
          }),
          z.object({
            role: z.literal('neo'),
            cursor: NeoConversationCursorSchema,
            publication: NeoStoredPublicationSchema,
          }),
        ])
      ),
      nextAfter: NeoConversationCursorSchema.nullable(),
      nextBefore: NeoConversationCursorSchema.nullable(),
    }),
  ]);
  return defineOperation({
    name: 'neo.conversation.read',
    description:
      'Read the recorded human and Neo conversation, oldest first within each page. With no cursor, returns the newest page. Use nextBefore as before for older history, or nextAfter as after for newer entries. Human words and attachment references come from the immutable intake record; Neo replies and revision history come from the publication ledger. Only the current public conversation is readable; SDK transcripts and internal notes are excluded.',
    policy: { safetyClass: 'read', roles: ['neo'] },
    inputSchema: NeoConversationReadInput,
    resultSchema,
    execute: async (page, caller) => read(page, caller),
  });
}
