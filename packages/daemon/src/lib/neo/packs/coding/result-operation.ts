import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { WorkRefSchema } from '../../../drivers/types.ts';
import { CodingStageFact } from './stage-facts.ts';
import type { CodingPrLedgerRepository } from './pr-ledger.ts';
import type { CodingAssignmentsRepository } from './assignments.ts';

const Input = z.object({ todoId: z.string().min(1), ref: WorkRefSchema, fact: CodingStageFact });
type Input = z.infer<typeof Input>;
type Result = { ok: boolean; reason?: string };

export function createCodingResultOperation(
  assignments: CodingAssignmentsRepository,
  ledger: CodingPrLedgerRepository
) {
  const record = (superpipe({})('coding.record-assigned-result') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: Input) => {
        const { fact } = input;
        const assignment = assignments.read(input.todoId, fact.url, fact.head)[fact.stage];
        return assignment &&
          assignment.acceptanceContract === fact.acceptanceContract &&
          isDeepStrictEqual(assignment.actor, fact.actor) &&
          isDeepStrictEqual(assignment.ref, input.ref)
          ? { value: fact }
          : { reason: { ok: false, reason: 'stage_assignment_mismatch' } };
      },
      'input',
      'result:fact'
    )
    .pipe(
      async (fact: CodingStageFact): Promise<Result> =>
        (await ledger.write('recordStage', fact))
          ? { ok: true }
          : { ok: false, reason: 'head_changed_or_failed_stage' },
      'fact',
      'fact'
    )
    .endAsync('fact') as (input: Input) => Promise<Result>;
  return defineOperation({
    name: 'neo.coding.result',
    description:
      'Record review or QA evidence for the exact persisted coding assignment. Requires its todo, worker ref, actor identity, PR head and acceptance-contract reference; rejects stale heads, mismatches and attempts to erase a failure. Bot approval is read from GitHub, never submitted through this operation.',
    inputSchema: Input,
    resultSchema: z.object({ ok: z.boolean(), reason: z.string().optional() }),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input) => record(input),
  });
}
