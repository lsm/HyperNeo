import type { SpaceGoal } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalSpace,
  GOAL_READ_POLICY,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { GoalStatusSchema, SpaceGoalSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    status: GoalStatusSchema.optional().describe('Filter by goal status'),
  })
  .strict()
  .default({});

type Input = z.infer<typeof inputSchema>;
type Result = { accepted: true; goals: SpaceGoal[] } | GoalRejection;

export interface ListGoalsDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'listGoals'>;
}

export function admitGoalListing(
  input: Input,
  caller: OperationCaller,
  deps: ListGoalsDependencies
): { value: string } | { reason: GoalRejection } {
  return admitGoalSpace(caller, input.spaceId, 'read', deps);
}

export function readGoalListing(
  spaceId: string,
  input: Input,
  deps: ListGoalsDependencies
): Result {
  return { accepted: true, goals: deps.goalService.listGoals({ spaceId, status: input.status }) };
}

const DESCRIPTION =
  'List long-horizon goals in a Space with rolling summary and progress; read this before changing goal state. Agent callers are scoped to their own Space; human callers pass spaceId. Returns { accepted: true, goals } or { accepted: false, reason }.';

export function createListGoalsOperation(deps: ListGoalsDependencies) {
  const listGoals = (superpipe({ deps })('goal-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalListing, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(readGoalListing, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.list',
    description: DESCRIPTION,
    policy: GOAL_READ_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), goals: z.array(SpaceGoalSchema) }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => listGoals(input, caller),
  });
}
