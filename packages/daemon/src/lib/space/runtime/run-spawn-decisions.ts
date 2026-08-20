import type { NodeExecution, NodeExecutionStatus, SpaceTaskStatus } from '@hyperneo/shared';

export function isCanonicalTaskTerminalForSpawn(status: SpaceTaskStatus): boolean {
  return (
    status === 'done' || status === 'cancelled' || status === 'archived' || status === 'stopped'
  );
}

export function isParkedAwaitingApproval(
  taskStatus: SpaceTaskStatus,
  pendingExecutions: readonly NodeExecution[]
): boolean {
  return (
    (taskStatus === 'review' || taskStatus === 'approved') &&
    pendingExecutions.some(
      (execution) => execution.startedAt !== null && execution.agentSessionId === null
    )
  );
}

export type SpawnAdmissionSkipReason =
  | 'canonical_task_terminal'
  | 'parked_awaiting_approval'
  | 'space_missing';

export type SpawnAdmissionDecision =
  | { action: 'skipSpawn'; reason: SpawnAdmissionSkipReason }
  | { action: 'noPendingExecutions' }
  | { action: 'spawn' };

export interface SpawnAdmissionInput {
  pendingExecutionCount: number;
  canonicalTaskStatus: SpaceTaskStatus;
  pendingExecutions: readonly NodeExecution[];
  hasSpace: boolean;
}

export function decideSpawnAdmission(input: SpawnAdmissionInput): SpawnAdmissionDecision {
  if (input.pendingExecutionCount <= 0) return { action: 'noPendingExecutions' };
  if (isCanonicalTaskTerminalForSpawn(input.canonicalTaskStatus)) {
    return { action: 'skipSpawn', reason: 'canonical_task_terminal' };
  }
  if (isParkedAwaitingApproval(input.canonicalTaskStatus, input.pendingExecutions)) {
    return { action: 'skipSpawn', reason: 'parked_awaiting_approval' };
  }
  if (!input.hasSpace) return { action: 'skipSpawn', reason: 'space_missing' };
  return { action: 'spawn' };
}

export function selectPromotablePendingExecutions(
  executions: readonly NodeExecution[],
  preTickPendingIds: ReadonlySet<string>,
  aliveSessionIds: ReadonlySet<string>
): NodeExecution[] {
  return executions.filter(
    (execution) =>
      execution.status === 'pending' &&
      execution.agentSessionId !== null &&
      preTickPendingIds.has(execution.id) &&
      aliveSessionIds.has(execution.agentSessionId)
  );
}

export type SpawnFailureClassification =
  | 'cancel_permanent'
  | 'defer_transient'
  | 'preserve_stale_terminal'
  | 'reset_retry';

export interface SpawnFailureClassificationInput {
  isPermanent: boolean;
  isTransient: boolean;
  staleExecutionStatus: NodeExecutionStatus;
}

export function classifySpawnFailure(
  input: SpawnFailureClassificationInput
): SpawnFailureClassification {
  if (input.isPermanent) return 'cancel_permanent';
  if (input.isTransient) return 'defer_transient';
  if (
    input.staleExecutionStatus === 'cancelled' ||
    input.staleExecutionStatus === 'blocked' ||
    input.staleExecutionStatus === 'idle'
  ) {
    return 'preserve_stale_terminal';
  }
  return 'reset_retry';
}

export function hasDriveableExecution(executions: readonly NodeExecution[]): boolean {
  return executions.some(
    (execution) =>
      execution.status === 'pending' ||
      execution.status === 'in_progress' ||
      execution.status === 'waiting_rebind' ||
      execution.status === 'blocked'
  );
}
