import type { SpaceTaskStatus } from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';

export type SpawnExecutionPermanentRejectReason =
  | 'task_archived'
  | 'task_cancelled'
  | 'workflow_invalid'
  | 'slot_unresolvable';

export type SpawnExecutionTransientRejectReason = 'task_rate_or_usage_limited';

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

export function decideSpawnExecutionAdmission(
  input: SpawnExecutionAdmissionInput
): SpawnExecutionAdmissionDecision {
  if (input.hasLiveIndexedSession) return { action: 'reuse_live' };
  if (input.isSpawningExecution) return { action: 'wait_concurrent' };
  if (input.taskStatus === 'archived') {
    return { action: 'reject_permanent', reason: 'task_archived' };
  }
  if (input.taskStatus === 'cancelled') {
    return { action: 'reject_permanent', reason: 'task_cancelled' };
  }
  if (isRateOrUsageLimited(input.taskStatus)) {
    return { action: 'reject_transient', reason: 'task_rate_or_usage_limited' };
  }
  if (!input.executionWorkflowValid) {
    return { action: 'reject_permanent', reason: 'workflow_invalid' };
  }
  if (!input.slotResolvable) {
    return { action: 'reject_permanent', reason: 'slot_unresolvable' };
  }
  return { action: 'proceed_fresh' };
}
