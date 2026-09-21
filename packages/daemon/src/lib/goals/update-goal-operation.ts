import type { SpaceGoal } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import {
  admitGoalAccess,
  GOAL_WRITE_POLICY,
  type GoalCallerContext,
  type GoalRejection,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  goalMutationContext,
  recordGoalAudit,
} from './goal-operation-scope.ts';
import {
  GoalMetricsSchema,
  GoalPrioritySchema,
  GoalStatusSchema,
  GoalTypeSchema,
  SpaceGoalSchema,
} from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

export const GoalWritableFieldsShape = {
  title: z.string().min(1).optional().describe('New goal title'),
  description: z.string().optional().describe('New goal description'),
  type: GoalTypeSchema.optional().describe('Goal type'),
  priority: GoalPrioritySchema.optional().describe('Goal priority'),
  labels: z.array(z.string()).optional().describe('Labels for future goal tasks'),
  metrics: GoalMetricsSchema.optional().describe('Structured measurement state'),
  summary: z.string().optional().describe('Rolling summary of current goal state'),
  progress: z.number().int().min(0).max(100).optional().describe('Progress percentage 0-100'),
  nextSteps: z.array(z.string()).optional().describe('Rolling list of next steps'),
  preferredWorkflowId: z
    .string()
    .nullable()
    .optional()
    .describe('Preferred workflow ID for future goal tasks'),
  autoTriggerNext: z
    .boolean()
    .optional()
    .describe('Queue one follow-up run when a trigger arrives while another goal task is active'),
  checkInCronExpression: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Edit the recurring check-in schedule in place. Omit to leave it unchanged. A cron expression updates the linked schedule cadence (creating one if none) and reschedules the next fire atomically. null removes the schedule. Never creates or detaches tasks and never touches pendingNextRun.'
    ),
  checkInTimezone: z
    .string()
    .optional()
    .describe('IANA timezone applied with checkInCronExpression (e.g. "UTC")'),
  workspacePath: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Registered secondary workspace path to pin this goal to. Omit to leave unchanged, null to unpin back to the Space primary workspace.'
    ),
};

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    goalId: z.string().min(1).describe('Goal ID'),
    ...GoalWritableFieldsShape,
    status: GoalStatusSchema.optional().describe(
      'New lifecycle status. The linked check-in schedule follows it: paused, completed and archived pause the schedule and clear nextCheckInAt, while active re-enables it and restores the next fire. Archived goals cannot be reactivated.'
    ),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Result = { accepted: true; goal: SpaceGoal } | GoalRejection;

export interface UpdateGoalDependencies extends GoalCallerContext {
  readonly goalService: Pick<
    SpaceGoalService,
    'getGoal' | 'updateGoal' | 'resolveGoalWorkspacePath'
  >;
}

export function admitGoalUpdate(
  input: Input,
  caller: OperationCaller,
  deps: UpdateGoalDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'mutate', deps, (goalId) =>
    deps.goalService.getGoal(goalId)
  );
}

export async function applyGoalUpdate(
  goal: SpaceGoal,
  input: Input,
  caller: OperationCaller,
  deps: UpdateGoalDependencies
): Promise<Result> {
  const { goalId: _goalId, spaceId: _spaceId, ...updates } = input;
  const { workspacePath, ...fields } = updates;
  const updated = deps.goalService.updateGoal(
    goal.id,
    {
      ...fields,
      workspacePath: await deps.goalService.resolveGoalWorkspacePath(goal.spaceId, workspacePath),
    },
    goalMutationContext(caller)
  );
  recordGoalAudit(deps, caller, goal.spaceId, 'goal.update', {
    goalId: goal.id,
    fields: Object.keys(updates),
  });
  return { accepted: true, goal: updated };
}

const DESCRIPTION =
  'Update goal fields and rolling state (summary, progress, metrics, nextSteps), move the goal between lifecycle statuses, or edit its check-in schedule in place. Set status to "paused" to pause a goal and its linked check-in schedule, or to "active" to resume both. Internal pointers such as activeTaskId are not writable. Requires an active session in the owning Space. Returns { accepted: true, goal } or { accepted: false, reason }.';

export function createUpdateGoalOperation(deps: UpdateGoalDependencies) {
  const update = (superpipe({ deps })('goal-update') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalUpdate, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(applyGoalUpdate, ['outcome', 'input', 'caller', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.update',
    description: DESCRIPTION,
    policy: GOAL_WRITE_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({ accepted: z.literal(true), goal: SpaceGoalSchema }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => update(input, caller),
  });
}
