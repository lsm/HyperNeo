import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NeoPublicationSchema } from './publication.ts';
import { isMainNeoBinding } from './binding-roles.ts';

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
type Failure = { ok: false; reason: 'human_only' | 'conversation_not_found' };
type Gate = { value: Page } | { reason: Failure };
type Result =
  | Failure
  | { ok: true; conversationId: string; items: NeoPublication[]; nextAfter: number };

export function requirePublicationReader(page: Page, caller: OperationCaller): Gate {
  return caller.source === 'rpc' && caller.principal === 'local'
    ? { value: page }
    : { reason: { ok: false, reason: 'human_only' } };
}

export function requirePublicationConversation(page: Page, root: NeoBinding | null): Gate {
  return isMainNeoBinding(root) && root.sessionId === `neo:${page.conversationId}`
    ? { value: page }
    : { reason: { ok: false, reason: 'conversation_not_found' } };
}

function readPublicationPage(page: Page, ledger: NeoPublicationRepository): Result {
  const items =
    page.before === undefined
      ? ledger.list(page.conversationId, page.after, page.limit)
      : ledger.list(page.conversationId, 0, page.limit, page.before);
  if (!items) throw new Error('Invalid admitted Neo publication page');
  return {
    ok: true,
    conversationId: page.conversationId,
    items,
    nextAfter: items.at(-1)?.sequence ?? page.after,
  };
}

const read = (superpipe({})('neo-publication-read') as PipelineAPI)
  .input(['page', 'caller', 'repo', 'ledger'])
  .pipe(requirePublicationReader, ['page', 'caller'], 'result:page')
  .pipe((repo: NeoRepository) => repo.getBindingForConcern(null), 'repo', 'root')
  .pipe(requirePublicationConversation, ['page', 'root'], 'result:page')
  .pipe(readPublicationPage, ['page', 'ledger'], 'page')
  .end('page') as (
  page: Page,
  caller: OperationCaller,
  repo: NeoRepository,
  ledger: NeoPublicationRepository
) => Result;

export function createNeoPublicationReadOperation(
  repo: NeoRepository,
  ledger: NeoPublicationRepository
) {
  return defineOperation({
    name: 'neo.publication.read',
    description:
      'Read one bounded ascending page of authored Neo replies and full details for the current public conversation. Use nextAfter for the next page or later updates, or pass before (for example Number.MAX_SAFE_INTEGER for the newest page) to read the page that ends just before that sequence; this never reads SDK transcripts or starts a query.',
    policy: { safetyClass: 'human_only' },
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.enum(['human_only', 'conversation_not_found']) }),
      z.object({
        ok: z.literal(true),
        conversationId: z.uuid(),
        items: z
          .array(
            NeoPublicationSchema.extend({
              sequence: z.number().int().positive(),
              createdAt: z.iso.datetime(),
            })
          )
          .max(100),
        nextAfter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }),
    ]),
    execute: async (page, caller) => read(page, caller, repo, ledger),
  });
}
