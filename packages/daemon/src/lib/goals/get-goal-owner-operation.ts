import type { SpaceGoal, SpaceGoalOwnerResolution } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceAgentGoalScopeRepository } from '../../storage/repositories/space-agent-goal-scope-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalAccess,
  GOAL_READ_POLICY,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { GoalOwnerResolutionSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({ ...GoalSpaceScopeShape, goalId: z.string().min(1).describe('Goal ID') })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Result = { accepted: true; owner: SpaceGoalOwnerResolution } | GoalRejection;

export interface GetGoalOwnerDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal'>;
  readonly goalScopeRepo: Pick<SpaceAgentGoalScopeRepository, 'getPrimaryGoalOwner'>;
}

export function admitGoalOwnerRead(
  input: Input,
  caller: OperationCaller,
  deps: GetGoalOwnerDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'read', deps, (goalId) => deps.goalService.getGoal(goalId));
}

export function presentGoalOwner(goal: SpaceGoal, deps: GetGoalOwnerDependencies): Result {
  return {
    accepted: true,
    owner: deps.goalScopeRepo.getPrimaryGoalOwner(
      goal.id,
      goal.spaceId
    ) as SpaceGoalOwnerResolution,
  };
}

const DESCRIPTION =
  'Read the primary long-horizon agent owner of one goal, with the conflicting assignments and the degraded reason when the owner agent is not active. A goal outside the caller Space reads as goal_not_found. Returns { accepted: true, owner } or { accepted: false, reason }.';

export function createGetGoalOwnerOperation(deps: GetGoalOwnerDependencies) {
  const getGoalOwner = (superpipe({ deps })('goal-owner-get') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalOwnerRead, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(presentGoalOwner, ['outcome', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.owner.get',
    description: DESCRIPTION,
    policy: GOAL_READ_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), owner: GoalOwnerResolutionSchema }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => getGoalOwner(input, caller),
  });
}
