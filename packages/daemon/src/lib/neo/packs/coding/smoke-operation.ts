import { isDeepStrictEqual } from 'node:util';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import {
  CodingSmoke,
  recordCodingSmoke,
  type CodingDeliveryFactsRepository,
} from './delivery-facts.ts';
import type { CodingAssignmentsRepository } from './assignments.ts';
import type { NeoDeployReader } from './deploy-checks.ts';

const Input = z.object({
  todoId: z.string().min(1),
  url: z.string().refine((url) => !!parsePrUrl(url)),
  head: z.string().min(1),
  smoke: CodingSmoke,
});
type Input = z.infer<typeof Input>;
type Result = { accepted: true } | { accepted: false; reason: string };

export function createCodingSmokeOperation(
  repo: CodingDeliveryFactsRepository,
  assignments: CodingAssignmentsRepository,
  readDeploys: NeoDeployReader
) {
  const record = (superpipe({})('coding.record-assigned-smoke') as PipelineAPI)
    .input(['input'])
    .pipe(
      (input: Input) => {
        const assignment = assignments.read(input.todoId, input.url, input.head).qa;
        const gate = repo.read(input.todoId, input.url, input.head)?.gate;
        return assignment &&
          isDeepStrictEqual(assignment.actor, input.smoke.actor) &&
          isDeepStrictEqual(assignment.ref, input.smoke.ref) &&
          (!gate ||
            (gate.acceptanceContract === assignment.acceptanceContract &&
              isDeepStrictEqual(gate.write, assignment.write)))
          ? { value: input }
          : { reason: { accepted: false, reason: 'stage_assignment_mismatch' } };
      },
      'input',
      'result:result'
    )
    .pipe(
      async (input: Input) =>
        recordCodingSmoke(
          repo,
          input.todoId,
          input.url,
          input.head,
          input.smoke,
          await readDeploys([input.url])
        ),
      'input',
      'result'
    )
    .endAsync('result') as (input: Input) => Promise<Result>;
  return defineOperation({
    name: 'neo.coding.smoke',
    description:
      'Record the assigned independent QA actor’s post-deploy smoke or explicit inapplicability. Reads actual merged-head and running-build containment facts; a failure is recorded for follow-up without changing the todo’s declared completion check. Does not merge, deploy or restart anything.',
    inputSchema: Input,
    resultSchema: z.union([
      z.object({ accepted: z.literal(true) }),
      z.object({ accepted: z.literal(false), reason: z.string() }),
    ]),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input) => record(input),
  });
}
