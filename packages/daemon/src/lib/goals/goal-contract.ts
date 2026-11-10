import { z } from 'zod';
import type { OperationCallerRole, OperationPolicy } from '../operations/registry.ts';

export type GoalAccess = 'read' | 'mutate' | 'owner';

const GOAL_ACCESS_ROLE_LISTS: Record<GoalAccess, readonly OperationCallerRole[]> = {
  read: ['long_term_agent', 'neo', 'workflow_worker', 'direct_task_worker'],
  mutate: ['long_term_agent', 'neo', 'workflow_worker', 'direct_task_worker'],
  owner: ['long_term_agent', 'neo', 'workflow_worker', 'direct_task_worker'],
};

export const GOAL_READ_POLICY = {
  safetyClass: 'read',
  roles: GOAL_ACCESS_ROLE_LISTS.read,
} as const satisfies OperationPolicy;

export const GOAL_WRITE_POLICY = {
  safetyClass: 'mutate',
  roles: GOAL_ACCESS_ROLE_LISTS.mutate,
} as const satisfies OperationPolicy;

export const GOAL_OWNER_POLICY = {
  safetyClass: 'mutate',
  roles: GOAL_ACCESS_ROLE_LISTS.owner,
} as const satisfies OperationPolicy;

export const GoalStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
export const GoalTypeSchema = z.enum(['one_shot', 'measurable', 'recurring']);
export const GoalPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const GoalMetricsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()])
);
