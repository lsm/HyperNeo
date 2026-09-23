import type { SpaceGoal, SpaceTaskCompact } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { TaskCoreSchema } from '../tasks/get-operation.ts';
import {
  admitGoalAccess,
  GOAL_READ_POLICY,
  GoalRejectionSchema,
  GoalSpaceScopeShape,
  type GoalCallerContext,
  type GoalRejection,
} from './goal-operation-scope.ts';
import { SpaceTaskCompactSchema } from './goal-result-schemas.ts';
import type { SpaceGoalService } from './service.ts';

const inputSchema = z
  .object({
    ...GoalSpaceScopeShape,
    goalId: z.string().min(1).describe('Goal ID'),
    status: TaskCoreSchema.shape.status.optional().describe('Filter by linked task status'),
    limit: z.number().int().min(1).max(100).optional().describe('Max tasks to return (default 20)'),
    before: z.number().int().optional().describe('Return tasks created before this timestamp'),
    beforeId: z.string().min(1).optional().describe('Cursor id for same-timestamp pagination'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;
type Page = { accepted: true; total: number; tasks: SpaceTaskCompact[]; hasMore: boolean };
type Result = Page | GoalRejection;

export interface ListGoalTasksDependencies extends GoalCallerContext {
  readonly goalService: Pick<SpaceGoalService, 'getGoal'>;
  readonly taskRepo: Pick<SpaceTaskRepository, 'getTask' | 'listByGoal'>;
}

export function admitGoalTaskListing(
  input: Input,
  caller: OperationCaller,
  deps: ListGoalTasksDependencies
): { value: SpaceGoal } | { reason: GoalRejection } {
  return admitGoalAccess(caller, input, 'read', deps, (goalId) => deps.goalService.getGoal(goalId));
}

export function readGoalTaskPage(
  goal: SpaceGoal,
  input: Input,
  deps: ListGoalTasksDependencies
): Result {
  const page = deps.taskRepo.listByGoal(goal.spaceId, goal.id, {
    status: input.status,
    limit: input.limit,
    before: input.before,
    beforeId: input.beforeId,
  });
  return {
    accepted: true,
    total: page.total,
    hasMore: page.hasMore,
    tasks: page.tasks.map((task) => ({
      id: task.id,
      taskNumber: task.taskNumber,
      title: task.title,
      status: task.status,
      priority: task.priority,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    })),
  };
}

const DESCRIPTION =
  'List tasks linked to a goal as a bounded page of compact summaries ordered newest-first; paginate with before/beforeId. Default limit 20, maximum 100. Returns { accepted: true, total, tasks, hasMore } or { accepted: false, reason }.';

export function createListGoalTasksOperation(deps: ListGoalTasksDependencies) {
  const listGoalTasks = (superpipe({ deps })('goal-tasks-list') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitGoalTaskListing, ['input', 'caller', 'deps'], 'result:outcome')
    .pipe(readGoalTaskPage, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Result>;
  return defineOperation({
    name: 'goal.task.list',
    description: DESCRIPTION,
    policy: GOAL_READ_POLICY,
    inputSchema,
    resultSchema: z.discriminatedUnion('accepted', [
      z.object({
        accepted: z.literal(true),
        total: z.number().int().min(0),
        tasks: z.array(SpaceTaskCompactSchema),
        hasMore: z.boolean(),
      }),
      GoalRejectionSchema,
    ]),
    execute: async (input, caller) => listGoalTasks(input, caller),
  });
}
