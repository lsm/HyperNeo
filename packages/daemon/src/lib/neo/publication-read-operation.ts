import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoPublicationSchema } from './publication.ts';

export const NeoStoredPublicationSchema = NeoPublicationSchema.extend({
  sequence: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const NeoConversationPageShape = z
  .object({
    conversationId: z.uuid(),
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(50),
    before: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const neoConversationPageCursorValid = (page: { before?: number; after: number }) =>
  page.before === undefined || page.after === 0;

export const NeoConversationPageInput = NeoConversationPageShape.refine(
  neoConversationPageCursorValid
);
type Page = z.infer<typeof NeoConversationPageInput>;
type Failure = { ok: false; reason: 'human_only' | 'conversation_not_found' };
type Gate = { value: Page } | { reason: Failure };
type Result =
  | Failure
  | { ok: true; conversationId: string; items: NeoPublication[]; nextAfter: number };

export function isNeoConversationSession(
  caller: OperationCaller,
  binding: NeoBinding | null
): boolean {
  return (
    caller.source === 'mcp' &&
    caller.role === 'neo' &&
    !!binding &&
    binding.sessionId === caller.sessionId &&
    binding.kind === 'neo'
  );
}

export function requirePublicationReader(
  page: Page,
  caller: OperationCaller,
  binding: NeoBinding | null
): Gate {
  return isLocalUser(caller) || isNeoConversationSession(caller, binding)
    ? { value: page }
    : { reason: { ok: false, reason: 'human_only' } };
}

export function requirePublicationConversation<Page extends { conversationId: string }>(
  page: Page,
  conversation: string | null
): { value: Page } | { reason: Failure } {
  return conversation !== null && page.conversationId === conversation
    ? { value: page }
    : { reason: { ok: false, reason: 'conversation_not_found' } };
}

export function readNeoConversationPage<T extends { sequence: number }>(
  page: Page,
  ledger: {
    list(conversationId: string, after: number, limit: number, before?: number): T[] | null;
  },
  kind: string
): { ok: true; conversationId: string; items: T[]; nextAfter: number } {
  const items =
    page.before === undefined
      ? ledger.list(page.conversationId, page.after, page.limit)
      : ledger.list(page.conversationId, 0, page.limit, page.before);
  if (!items) throw new Error(`Invalid admitted Neo ${kind} page`);
  return {
    ok: true,
    conversationId: page.conversationId,
    items,
    nextAfter: items.at(-1)?.sequence ?? page.after,
  };
}

export const readNeoPublicationPage = (superpipe({})('neo-publication-read') as PipelineAPI)
  .input(['page', 'caller', 'repo', 'ledger'])
  .pipe(
    (caller: OperationCaller, repo: NeoRepository) =>
      caller.source === 'mcp' && caller.sessionId
        ? repo.getBindingBySession(caller.sessionId)
        : null,
    ['caller', 'repo'],
    'binding'
  )
  .pipe(requirePublicationReader, ['page', 'caller', 'binding'], 'result:page')
  .pipe((repo: NeoRepository) => repo.conversationId(), 'repo', 'conversation')
  .pipe(requirePublicationConversation, ['page', 'conversation'], 'result:page')
  .pipe(
    (page: Page, ledger: NeoPublicationRepository) =>
      readNeoConversationPage(page, ledger, 'publication'),
    ['page', 'ledger'],
    'page'
  )
  .end('page') as (
  page: Page,
  caller: OperationCaller,
  repo: NeoRepository,
  ledger: NeoPublicationRepository
) => Result;

export function createNeoPublicationReadOperation(ledger: NeoPublicationRepository) {
  return defineOperation({
    name: 'neo.publication.read',
    description:
      'Read one bounded ascending page of authored Neo replies and full details for the current public conversation. Use nextAfter for the next page or later updates, or pass before (for example Number.MAX_SAFE_INTEGER for the newest page) to read the page that ends just before that sequence; this never reads SDK transcripts or starts a query.',
    policy: { safetyClass: 'read', roles: ['neo'] },
    inputSchema: NeoConversationPageInput,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.enum(['human_only', 'conversation_not_found']) }),
      z.object({
        ok: z.literal(true),
        conversationId: z.uuid(),
        items: z.array(NeoStoredPublicationSchema).max(100),
        nextAfter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    ]),
    execute: async (page, caller) => ledger.readPageCurrent(page, caller),
  });
}
