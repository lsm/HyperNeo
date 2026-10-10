import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoConversationAskSchema } from './conversation-ask.ts';
import {
  requirePublicationReader,
  requirePublicationConversation,
} from './publication-read-operation.ts';

const Input = z
  .object({
    conversationId: z.uuid(),
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
    before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .refine((page) => page.before === undefined || page.after === 0);
type Page = z.infer<typeof Input>;
type Result =
  | { ok: false; reason: 'human_only' | 'conversation_not_found' }
  | { ok: true; conversationId: string; items: NeoConversationAsk[]; nextAfter: number };

const StoredAsk = z
  .preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { sequence, createdAt, delivery, ...ask } = value as Record<string, unknown>;
      return { sequence, createdAt, delivery, ask };
    },
    z.object({
      sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      createdAt: z.iso.datetime(),
      delivery: z
        .object({ state: z.literal('failed') })
        .strict()
        .optional(),
      ask: NeoConversationAskSchema,
    })
  )
  .transform(({ sequence, createdAt, delivery, ask }) => ({
    ...ask,
    sequence,
    createdAt,
    ...(delivery ? { delivery } : {}),
  }));

export type NeoAskSendStatusReader = (sessionId: string, messageId: string) => string | null;

export function presentNeoAskDelivery(
  items: readonly NeoConversationAsk[],
  statuses: readonly (string | null)[]
): NeoConversationAsk[] {
  return items.map((item, index) =>
    statuses[index] === 'failed' ? { ...item, delivery: { state: 'failed' as const } } : item
  );
}

function readAskDelivery(result: Result, readSendStatus: NeoAskSendStatusReader): Result {
  if (!result.ok) return result;
  const statuses = result.items.map((item) =>
    readSendStatus(item.askOrigin.sessionId, item.askOrigin.messageId)
  );
  return { ...result, items: presentNeoAskDelivery(result.items, statuses) };
}

function readAskPage(page: Page, ledger: NeoConversationAskRepository): Result {
  const items =
    page.before === undefined
      ? ledger.list(page.conversationId, page.after, page.limit)
      : ledger.list(page.conversationId, 0, page.limit, page.before);
  if (!items) throw new Error('Invalid admitted Neo ask page');
  return {
    ok: true,
    conversationId: page.conversationId,
    items,
    nextAfter: items.at(-1)?.sequence ?? page.after,
  };
}

const read = (superpipe({})('neo-conversation-ask-read') as PipelineAPI)
  .input(['page', 'caller', 'repo', 'ledger', 'readSendStatus'])
  .pipe(requirePublicationReader, ['page', 'caller'], 'result:page')
  .pipe((repo: NeoRepository) => repo.getBindingForConcern(null), 'repo', 'root')
  .pipe(requirePublicationConversation, ['page', 'root'], 'result:page')
  .pipe(readAskPage, ['page', 'ledger'], 'page')
  .pipe(readAskDelivery, ['page', 'readSendStatus'], 'page')
  .end('page') as (
  page: Page,
  caller: OperationCaller,
  repo: NeoRepository,
  ledger: NeoConversationAskRepository,
  readSendStatus: NeoAskSendStatusReader
) => Result;

export function createNeoConversationAskReadOperation(
  repo: NeoRepository,
  ledger: NeoConversationAskRepository,
  readSendStatus: NeoAskSendStatusReader = () => null
) {
  return defineOperation({
    name: 'neo.conversation.asks.read',
    description:
      'Read one bounded ascending page of durably accepted human asks for the current public conversation. Original request identities and content are preserved; this never reads execution transcripts or starts a query. Use nextAfter for later pages, or pass before (for example Number.MAX_SAFE_INTEGER for the newest page) to read the page that ends just before that sequence. An ask that could not be delivered carries delivery: { state: "failed" }.',
    policy: { safetyClass: 'human_only' },
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.enum(['human_only', 'conversation_not_found']) }),
      z.object({
        ok: z.literal(true),
        conversationId: z.uuid(),
        items: z.array(StoredAsk).max(100),
        nextAfter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    ]),
    execute: async (page, caller) => read(page, caller, repo, ledger, readSendStatus),
  });
}
