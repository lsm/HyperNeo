import type { Database } from '../../storage/sqlite-compat.ts';
import { presentNeoPreviewAsk } from './preview-context.ts';
import type { NeoSessionMessage } from '@hyperneo/shared/types/neo-session-message';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { NeoConversationWakeSchema } from '../../storage/repositories/neo-conversation-wake-repository.ts';
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
      !!binding &&
      binding.sessionId === caller.sessionId &&
      binding.kind === 'neo')
    ? { value: page }
    : { reason: { ok: false, reason: 'reader_not_authorized' } };
}

export function createNeoConversationReadOperation(
  repo: NeoRepository,
  ledger: NeoConversationReader,
  present: (message: NeoSessionMessage) => Promise<NeoSessionMessage> = async (message) => message,
  database?: Database
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
      async (page: NeoConversationPage, caller: OperationCaller) => ({
        ok: true as const,
        conversationId: page.conversationId,
        ...(await ledger.read(page, caller.source === 'rpc')),
      }),
      ['page', 'caller'],
      'page'
    )
    .endAsync('page') as (
    page: NeoConversationPage,
    caller: OperationCaller
  ) => Promise<
    | Rejected
    | ({
        ok: true;
        conversationId: string;
      } & Awaited<ReturnType<NeoConversationReader['read']>>)
  >;
  const resultSchema: z.ZodType<Awaited<ReturnType<typeof read>>> = z.union([
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
            role: z.literal('wake'),
            cursor: NeoConversationCursorSchema,
            wake: NeoConversationWakeSchema,
          }),
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
          z.object({
            role: z.literal('session'),
            cursor: NeoConversationCursorSchema,
            message: z.object({
              messageId: z.string(),
              conversationId: z.string(),
              sequence: z.number(),
              fromSession: z.string(),
              fromName: z.string().nullable(),
              toSession: z.string(),
              toName: z.string().nullable(),
              text: z.string(),
              createdAt: z.string(),
            }),
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
      'Read the recorded human and Neo conversation, with the messages root Neo exchanged with other sessions (role session; the human sees the ones Neo sent and system-forwarded worker batches), oldest first within each page. With no cursor, returns the newest page. Use nextBefore as before for older history, or nextAfter as after for newer entries. Human words and attachment references come from the immutable intake record; each human ask carries the same daemon-computed messageStatus as neo.conversation.asks.read. Neo replies and revision history come from the publication ledger. Session messages come from message.send records and separately released worker batches; batch disclosures project text only. Scheduled wakes appear as role wake with their summary and attributed additions. Only the current public conversation is readable; SDK transcripts and raw internal notes are excluded.',
    policy: { safetyClass: 'read', roles: ['neo'] },
    inputSchema: NeoConversationReadInput,
    resultSchema,
    execute: async (page, caller) => {
      const result = await read(page, caller);
      return result.ok
        ? {
            ...result,
            items: await Promise.all(
              result.items.map(async (item) =>
                item.role === 'session'
                  ? { ...item, message: await present(item.message) }
                  : item.role === 'human' && database
                    ? { ...item, ask: await presentNeoPreviewAsk(item.ask, database, caller) }
                    : item
              )
            ),
          }
        : result;
    },
  });
}
