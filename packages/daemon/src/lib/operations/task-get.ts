import type { SpaceTask } from '@hyperneo/shared/types/space';
import type { TaskCore, TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import { VALID_TASK_TRANSITIONS } from '../tasks/transitions.ts';
import { defineOperation } from './registry.ts';

export const TaskCoreSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(Object.keys(VALID_TASK_TRANSITIONS) as TaskLifecycleStatus[]),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  labels: z.array(z.string()),
  dependsOn: z.array(z.string()),
  result: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number(),
}) satisfies z.ZodType<TaskCore>;

type SpaceOnlyFields = Omit<SpaceTask, keyof TaskCore>;

const TaskRestrictionSchema = z.object({
  type: z.enum(['rate_limit', 'usage_limit']),
  limit: z.string(),
  resetAt: z.number(),
  sessionRole: z.enum(['worker', 'leader']),
  retryAfter: z.number().optional(),
});

export const TaskWithSpaceFieldsSchema = TaskCoreSchema.extend({
  spaceId: z.string().optional(),
  taskNumber: z.number().optional(),
  workflowRunId: z.string().nullable().optional(),
  preferredWorkflowId: z.string().nullable().optional(),
  createdByTaskId: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
  createdBySession: z.string().nullable().optional(),
  createdByTaskScheduleId: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  evolutionScopeId: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  workflowModelOverrides: z.record(z.string(), z.string()).optional(),
  activeSession: z.enum(['worker', 'leader']).nullable().optional(),
  taskAgentSessionId: z.string().nullable().optional(),
  blockReason: z
    .enum([
      'agent_crashed',
      'workflow_invalid',
      'execution_failed',
      'human_input_requested',
      'dependency_failed',
      'dependency_added',
    ])
    .nullable()
    .optional(),
  approvalSource: z.enum(['human', 'auto_policy', 'agent']).nullable().optional(),
  approvalReason: z.string().nullable().optional(),
  approvedAt: z.number().nullable().optional(),
  pendingCheckpointType: z.literal('task_completion').nullable().optional(),
  pendingCompletionGeneration: z.number().optional(),
  pendingCompletionSubmittedByNodeId: z.string().nullable().optional(),
  pendingCompletionSubmittedAt: z.number().nullable().optional(),
  pendingCompletionReason: z.string().nullable().optional(),
  reportedStatus: z.enum(['done', 'blocked', 'cancelled']).nullable().optional(),
  reportedSummary: z.string().nullable().optional(),
  postApprovalSessionId: z.string().nullable().optional(),
  postApprovalStartedAt: z.number().nullable().optional(),
  postApprovalBlockedReason: z.string().nullable().optional(),
  postApprovalSourceNodeId: z.string().nullable().optional(),
  restrictions: TaskRestrictionSchema.nullable().optional(),
  terminalGeneration: z.number().optional(),
}) satisfies z.ZodType<TaskCore & Partial<SpaceOnlyFields>>;

export function createGetTaskOperation(
  readTask: (taskId: string) => TaskCore | null | Promise<TaskCore | null>
) {
  return defineOperation({
    name: 'task.get',
    description:
      'Read task data by its global task ID. Returns null when absent. A Space-owned task includes its Space fields (ownership, workflow, approval, and pending-completion state); a standalone task returns only core fields.',
    inputSchema: z.object({ taskId: z.string().min(1) }),
    resultSchema: TaskWithSpaceFieldsSchema.nullable(),
    execute: async (input) => readTask(input.taskId),
  });
}
