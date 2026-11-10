import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoCardSearchPage } from '../../storage/neo-card-search.ts';
import { buildFtsQuery, buildShortSearchPattern } from '../../storage/message-search.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';

type Rejection = { ok: false; reason: string };
type Outcome = { ok: true; results: NeoCardSearchPage['results']; nextCursor: string | null };

const CardSearchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (query) => !!(buildFtsQuery(query) || buildShortSearchPattern(query)),
      'query_too_short'
    ),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(32).optional(),
});

export function createNeoCardSearchOperation(
  search: (query: string, cursor?: string, limit?: number) => Promise<NeoCardSearchPage>,
  admit: (caller: OperationCaller) => { value: OperationCaller } | { reason: Rejection }
) {
  const run = (superpipe({})('neo-ask-search') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:outcome')
    .pipe(
      (input: z.infer<typeof CardSearchInput>) => search(input.query, input.cursor, input.limit),
      'input',
      'page'
    )
    .pipe((page: NeoCardSearchPage) => ({ ok: true, ...page }), 'page', 'outcome')
    .endAsync('outcome') as (
    input: z.infer<typeof CardSearchInput>,
    caller: OperationCaller
  ) => Promise<Outcome | Rejection>;
  return defineOperation({
    name: 'neo.ask.search',
    description: neoToolDescription('neo.ask.search'),
    inputSchema: CardSearchInput,
    resultSchema: z.union([
      z.object({ ok: z.literal(false), reason: z.string() }),
      z.object({
        ok: z.literal(true),
        results: z.array(
          z.object({
            askId: z.string(),
            todoId: z.string().nullable(),
            questionId: z.string().nullable(),
            field: z.enum(['title', 'meta', 'body']),
            score: z.number(),
            snippet: z.string(),
          })
        ),
        nextCursor: z.string().nullable(),
      }),
    ]),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: run,
  });
}
