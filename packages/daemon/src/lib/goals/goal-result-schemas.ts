import type { SpaceGoal } from '@hyperneo/shared';
import { z } from 'zod';

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
