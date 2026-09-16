import type { SpaceGoal, SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../tasks/get-operation.ts';
import {
  admitGoalAccess,
  GOAL_WRITE_POLICY,
  goalMutationContext,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  recordGoalAudit,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { SpaceGoalSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({ ...GoalSpaceScopeShape, goalId: z.string().min(1).describe('Goal ID') })
  .strict();

type Input = z.infer<typeof inputSchema>;
type GoalResult = { accepted: true; goal: SpaceGoal } | GoalRejection;
type TriggerResult =
  | { accepted: true; goal: SpaceGoal; task: SpaceTask | null; queued: boolean }
  | GoalRejection;

export interface GoalStateDependencies extends GoalCallerContext {
  readonly goalService: Pick<
    SpaceGoalService,
    'getGoal' | 'pauseGoal' | 'resumeGoal' | 'createImmediateTask'
  >;
}

export function admitGoalStateWrite(
  input: Input,
  caller: OperationCaller,
  deps: GoalStateDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'mutate', deps, (goalId) =>
    deps.goalService.getGoal(goalId)
  );
}

export function applyGoalPause(
  goal: SpaceGoal,
  caller: OperationCaller,
  deps: GoalStateDependencies
): GoalResult {
  const paused = deps.goalService.pauseGoal(goal.id, goalMutationContext(caller));
  recordGoalAudit(deps, caller, goal.spaceId, 'goal.pause', { goalId: goal.id });
  return { accepted: true, goal: paused };
}

export function applyGoalResume(
  goal: SpaceGoal,
  caller: OperationCaller,
  deps: GoalStateDependencies
): GoalResult {
  const resumed = deps.goalService.resumeGoal(goal.id, goalMutationContext(caller));
  recordGoalAudit(deps, caller, goal.spaceId, 'goal.resume', { goalId: goal.id });
  return { accepted: true, goal: resumed };
}

export function applyGoalTrigger(
  goal: SpaceGoal,
  caller: OperationCaller,
  deps: GoalStateDependencies
): TriggerResult {
  const triggered = deps.goalService.createImmediateTask(goal.id, goalMutationContext(caller));
  recordGoalAudit(
    deps,
    caller,
    goal.spaceId,
    'goal.triggerTask',
    { goalId: goal.id },
    triggered.task?.id
  );
  return {
    accepted: true,
    goal: triggered.goal,
    task: triggered.task,
    queued: triggered.queued,
  };
}

const goalResultSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), goal: SpaceGoalSchema }),
  GoalRejectionSchema,
]);

function stateWritePipeline<Result>(
  name: string,
  apply: (goal: SpaceGoal, caller: OperationCaller, deps: GoalStateDependencies) => Result,
  deps: GoalStateDependencies
) {
  return (superpipe({ deps })(name) as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalStateWrite, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(apply, ['outcome', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (
    input: Input,
    caller: OperationCaller
  ) => Promise<Result | GoalRejection>;
}

export function createPauseGoalOperation(deps: GoalStateDependencies) {
  const pause = stateWritePipeline('goal-pause', applyGoalPause, deps);
  return defineOperation({
    name: 'goal.pause',
    description:
      'Pause an active goal and its linked check-in schedule if present. Requires an active session in the owning Space. Returns { accepted: true, goal } or { accepted: false, reason }.',
    policy: GOAL_WRITE_POLICY,
    inputSchema,
    resultSchema: goalResultSchema,
    execute: async (input, caller) => pause(input, caller),
  });
}

export function createResumeGoalOperation(deps: GoalStateDependencies) {
  const resume = stateWritePipeline('goal-resume', applyGoalResume, deps);
  return defineOperation({
    name: 'goal.resume',
    description:
      'Resume a paused goal and re-enable its linked check-in schedule if present. Requires an active session in the owning Space. Returns { accepted: true, goal } or { accepted: false, reason }.',
    policy: GOAL_WRITE_POLICY,
    inputSchema,
    resultSchema: goalResultSchema,
    execute: async (input, caller) => resume(input, caller),
  });
}

export function createTriggerGoalTaskOperation(deps: GoalStateDependencies) {
  const trigger = stateWritePipeline('goal-trigger-task', applyGoalTrigger, deps);
  return defineOperation({
    name: 'goal.triggerTask',
    description:
      'Create an immediate task for a goal, queueing one follow-up instead when another goal task is active and autoTriggerNext is set. Requires an active session in the owning Space. Returns { accepted: true, goal, task, queued } or { accepted: false, reason }.',
    policy: GOAL_WRITE_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({
        accepted: z.literal(true),
        goal: SpaceGoalSchema,
        task: TaskWithSpaceFieldsSchema.nullable(),
        queued: z.boolean(),
      }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => trigger(input, caller),
  });
}
