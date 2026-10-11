import type { SpaceTaskStatus } from '@hyperneo/shared';

export type SpawnExecutionPermanentRejectReason =
  | 'task_archived'
  | 'task_cancelled'
  | 'workflow_invalid'
  | 'slot_unresolvable';

export type SpawnExecutionTransientRejectReason = 'task_rate_or_usage_limited' | 'task_blocked';

export interface SpawnExecutionAdmissionInput {
  hasLiveIndexedSession: boolean;
  isSpawningExecution: boolean;
  taskStatus: SpaceTaskStatus;
  executionWorkflowValid: boolean;
  slotResolvable: boolean;
}

export type SpawnExecutionAdmissionDecision =
  | { action: 'reuse_live' }
  | { action: 'wait_concurrent' }
  | { action: 'proceed_fresh' }
  | { action: 'reject_permanent'; reason: SpawnExecutionPermanentRejectReason }
  | { action: 'reject_transient'; reason: SpawnExecutionTransientRejectReason };
