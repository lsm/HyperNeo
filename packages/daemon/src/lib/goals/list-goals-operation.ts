import type { SpaceGoal, SpaceGoalListParams } from '@hyperneo/shared';
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
    includeArchived: z
      .boolean()
      .optional()
      .describe('Include archived goals; ignored when status is given'),
    label: z.string().min(1).optional().describe('Filter by goal label'),
    search: z.string().min(1).optional().describe('Case-insensitive match on title or description'),
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
  const params: SpaceGoalListParams = {
    spaceId,
    status: input.status,
    includeArchived: input.includeArchived,
    label: input.label,
    search: input.search,
  };
  return { accepted: true, goals: deps.goalService.listGoals(params) };
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
