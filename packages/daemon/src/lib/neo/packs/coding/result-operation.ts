import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { WorkRefSchema } from '../../../drivers/types.ts';
import { CodingStageFact } from './stage-facts.ts';
import type { CodingAssignmentsRepository } from './assignments.ts';

const Input = z.object({
  todoId: z.string().min(1),
  ref: WorkRefSchema,
  fact: CodingStageFact.extend({
    stage: z
      .enum(['review', 'verify', 'qa'])
      .transform((stage) => (stage === 'verify' ? 'qa' : stage)),
  }),
});
type Input = z.infer<typeof Input>;
type Result = { ok: boolean; reason?: string };

export function createCodingResultOperation(assignments: CodingAssignmentsRepository) {
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
          ? { value: { ...fact, ref: input.ref } }
          : { reason: { ok: false, reason: 'stage_assignment_mismatch' } };
      },
      'input',
      'result:fact'
    )
    .pipe(
      async (input: Input, fact: CodingStageFact): Promise<Result> =>
        (await assignments.write('recordResult', input.todoId, fact))
          ? { ok: true }
          : { ok: false, reason: 'head_changed_or_failed_stage' },
      ['input', 'fact'],
      'fact'
    )
    .endAsync('fact') as (input: Input) => Promise<Result>;
  return defineOperation({
    name: 'neo.coding.result',
    description:
      'Record Review or Verify evidence for the exact persisted coding assignment (legacy qa remains accepted). Accepts its author or stage todo, worker ref, actor identity, PR head and acceptance-contract reference. A verdict closes only its stage todo; an old-head verdict never updates current-head facts. Legacy assignments reject stale heads; identity mismatches and attempts to erase a failure refuse. Bot approval is read from GitHub, never submitted through this operation.',
    inputSchema: Input,
    resultSchema: z.object({ ok: z.boolean(), reason: z.string().optional() }),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input) => record(input),
  });
}
