import type { SpaceGoal } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalAccess,
  GOAL_READ_POLICY,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { SpaceGoalSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({ ...GoalSpaceScopeShape, goalId: z.string().min(1).describe('Goal ID') })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Result = { accepted: true; goal: SpaceGoal } | GoalRejection;

export interface GetGoalDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal'>;
}

export function admitGoalRead(
  input: Input,
  caller: OperationCaller,
  deps: GetGoalDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'read', deps, (goalId) => deps.goalService.getGoal(goalId));
}

export function presentGoal(goal: SpaceGoal): Result {
  return { accepted: true, goal };
}

const DESCRIPTION =
  'Get one goal with rolling state, active task pointers, next check-in, metrics, and next steps. A goal outside the caller Space reads as goal_not_found. Returns { accepted: true, goal } or { accepted: false, reason }.';

export function createGetGoalOperation(deps: GetGoalDependencies) {
  const getGoal = (superpipe({ deps })('goal-get') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalRead, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(presentGoal, 'outcome', 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.get',
    description: DESCRIPTION,
    policy: GOAL_READ_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), goal: SpaceGoalSchema }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => getGoal(input, caller),
  });
}
