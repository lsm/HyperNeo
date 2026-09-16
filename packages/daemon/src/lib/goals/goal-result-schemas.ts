import type { SpaceGoal, SpaceGoalEventSnapshot, SpaceTaskCompact } from '@hyperneo/shared';
import { z } from 'zod';
import { TaskCoreSchema } from '../tasks/get-operation.ts';

export const GoalStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
export const GoalTypeSchema = z.enum(['one_shot', 'measurable', 'recurring']);
export const GoalPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const GoalMetricsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);

export const SpaceGoalSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string(),
  description: z.string(),
  status: GoalStatusSchema,
  type: GoalTypeSchema,
  priority: GoalPrioritySchema,
  labels: z.array(z.string()),
  metrics: GoalMetricsSchema,
  summary: z.string(),
  progress: z.number(),
  nextSteps: z.array(z.string()),
  preferredWorkflowId: z.string().nullable(),
  taskScheduleId: z.string().nullable(),
  autoTriggerNext: z.boolean(),
  pendingNextRun: z.boolean(),
  activeTaskId: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  lastCheckInAt: z.number().nullable(),
  nextCheckInAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  workspacePath: z.string().nullable().optional(),
  revision: z.number(),
}) satisfies z.ZodType<SpaceGoal>;

export const GoalSnapshotSchema = SpaceGoalSchema.omit({
  id: true,
  spaceId: true,
  createdAt: true,
  updatedAt: true,
  revision: true,
})
  .extend({
    progress: z.number().nullable(),
    checkInCronExpression: z.string().nullable(),
    checkInTimezone: z.string().nullable(),
  })
  .partial() satisfies z.ZodType<SpaceGoalEventSnapshot>;

export const GoalEventDiffSchema = z.record(
  z.string(),
  z.object({ previous: z.unknown(), current: z.unknown() })
);

export const SpaceGoalEventSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  goalId: z.string(),
  eventType: z.enum([
    'created',
    'updated',
    'status_changed',
    'task_triggered',
    'task_queued',
    'task_terminal',
    'schedule_updated',
  ]),
  source: z.enum(['rpc', 'space_agent_tool', 'workflow_node_agent', 'scheduler', 'system']),
  sourceTaskId: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  previousState: GoalSnapshotSchema.nullable(),
  newState: GoalSnapshotSchema.nullable(),
  diff: GoalEventDiffSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.number(),
});

export const SpaceTaskCompactSchema = z.object({
  id: z.string(),
  taskNumber: z.number(),
  title: z.string(),
  status: TaskCoreSchema.shape.status,
  priority: GoalPrioritySchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies z.ZodType<SpaceTaskCompact>;
