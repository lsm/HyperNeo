import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { defineOperation } from '../../../operations/registry.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { readCodingDaemonMergeFacts } from './daemon-merge-facts.ts';
import { decideCodingDaemonMerge } from './daemon-merge-gates.ts';
import { CODING_DAEMON_MERGE_MAX_ATTEMPTS } from './daemon-merge-attempt.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';

const Input = z
  .object({
    url: z
      .string()
      .url()
      .refine((url) => !!parsePrUrl(url))
      .transform((url) => url.toLowerCase()),
    head: z.string().regex(/^[a-f\d]{40}$/i),
  })
  .strict();
type Input = z.infer<typeof Input>;
const refuse = (reason: string) => ({ reason: { accepted: false as const, reason } });

export function createCodingRetryMergeOperation(
  database: () => Database,
  ledger: CodingPrLedgerRepository,
  spawn: SpawnFn = spawnProcess
) {
  const retry = (superpipe({})('coding.retry-daemon-merge') as PipelineAPI)
    .input('input')
    .pipe(
      async (input: Input) => {
        const [failure] = await ledger.write('daemonMerge', { kind: 'failures', ...input });
        return (failure?.failures ?? 0) >= CODING_DAEMON_MERGE_MAX_ATTEMPTS
          ? { value: input }
          : refuse('No stopped merge budget exists for this exact PR head.');
      },
      'input',
      'result:result'
    )
    .pipe(
      async (input: Input) => {
        const pr = parsePrUrl(input.url)!;
        const facts = await readCodingDaemonMergeFacts(database(), input.url, spawn);
        const { policy } = await ledger.pollContextCurrent(`${pr.owner}/${pr.repo}`);
        const decision = decideCodingDaemonMerge(facts, policy);
        return decision.kind === 'merge' && decision.head === input.head
          ? { value: input }
          : refuse(
              `Fresh merge gates must pass on this exact head before retrying: ${decision.kind === 'merge' ? 'head_changed' : decision.kind === 'skip' || decision.kind === 'read_failure' ? decision.reason : decision.kind}.`
            );
      },
      'result',
      'result:result'
    )
    .pipe(
      async (input: Input) => {
        await ledger.write('daemonMerge', { kind: 'retry', ...input, at: Date.now() });
        return { accepted: true as const };
      },
      'result',
      'result'
    )
    .endAsync('result') as (input: Input) => Promise<{ accepted: boolean; reason?: string }>;
  return defineOperation({
    name: 'neo.coding.merge.retry',
    description:
      'Neo accepts a stopped daemon merge report for an exact PR head after every fresh merge gate passes. Reopens its three-attempt budget without deleting historical failures or changing preferences. Does not merge; the daemon checks all gates again on its next sweep.',
    inputSchema: Input,
    resultSchema: z.object({ accepted: z.boolean(), reason: z.string().optional() }),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) =>
      caller.role === 'neo'
        ? retry(input)
        : { accepted: false, reason: 'Only Neo can accept a stopped daemon merge report.' },
  });
}
