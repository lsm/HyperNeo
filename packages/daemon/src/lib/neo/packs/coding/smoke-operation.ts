import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { CodingSmoke, type CodingDeliveryFactsRepository } from './delivery-facts.ts';
import type { CodingAssignmentsRepository } from './assignments.ts';
import type { NeoDeployReader } from './deploy-checks.ts';

const Input = z.object({
  todoId: z.string().min(1),
  url: z
    .string()
    .refine((url) => !!parsePrUrl(url))
    .meta({ examples: ['https://github.com/example/repo/pull/1'] }),
  head: z.string().min(1),
  smoke: CodingSmoke,
});
export type CodingSmokeRequest = z.infer<typeof Input>;
type Input = CodingSmokeRequest;
type Result = { accepted: true } | { accepted: false; reason: string };

export function createCodingSmokeOperation(
  repo: CodingDeliveryFactsRepository,
  assignments: CodingAssignmentsRepository,
  readDeploys: NeoDeployReader
) {
  const record = (superpipe({})('coding.record-assigned-smoke') as PipelineAPI)
    .input(['input'])
    .pipe((input: Input) => assignments.smokeAssignmentCurrent(input), 'input', 'result:result')
    .pipe(
      async (input: Input) =>
        repo.recordAssignedSmokeCurrent(input, await readDeploys([input.url])),
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
