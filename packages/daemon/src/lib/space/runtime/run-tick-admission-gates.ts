import {
  isRateOrUsageLimited,
  isWorkflowRunSucceeded,
  isWorkflowRunWaiting,
  type SpaceTaskStatus,
  type WorkflowRunStatus,
} from '@hyperneo/shared';

export interface RunTickAdmissionInput {
  runStatus: WorkflowRunStatus | null;
  hasExecutorMeta: boolean;
  runTaskCount: number;
  hasCanonicalTask: boolean;
  hasEndNodeId: boolean;
  canonicalTaskStatus: SpaceTaskStatus | null;
  executionCount: number;
  runIsComplete: boolean;
  hasBlockedExecution: boolean;
  firstBlockedResult: string | null;
  availableTaskSlots: number;
}

export type RunTickAdmissionDecision =
  | { action: 'clearFinishedRun' }
  | { action: 'recoverWaitingRun' }
  | {
      action: 'skip';
      reason:
        | 'missing_run'
        | 'no_executor_meta'
        | 'no_run_tasks'
        | 'no_canonical_task'
        | 'rate_or_usage_limited'
        | 'task_stopped'
        | 'no_executions';
    }
  | { action: 'blockInvalidWorkflow' }
  | { action: 'blockOnBlockedExecutions'; blockedReason: string }
  | { action: 'deferNoAvailableSlots' }
  | { action: 'proceed' };

export function decideRunTickAdmission(input: RunTickAdmissionInput): RunTickAdmissionDecision {
  if (input.runStatus === null) return { action: 'skip', reason: 'missing_run' };
  if (input.runStatus === 'cancelled' || isWorkflowRunSucceeded(input.runStatus)) {
    return { action: 'clearFinishedRun' };
  }
  if (isWorkflowRunWaiting(input.runStatus)) return { action: 'recoverWaitingRun' };
  if (!input.hasExecutorMeta) return { action: 'skip', reason: 'no_executor_meta' };
  if (input.runTaskCount === 0) return { action: 'skip', reason: 'no_run_tasks' };
  if (!input.hasCanonicalTask) return { action: 'skip', reason: 'no_canonical_task' };
  if (!input.hasEndNodeId) return { action: 'blockInvalidWorkflow' };
  if (input.canonicalTaskStatus !== null && isRateOrUsageLimited(input.canonicalTaskStatus)) {
    return { action: 'skip', reason: 'rate_or_usage_limited' };
  }
  if (input.canonicalTaskStatus === 'stopped') {
    return { action: 'skip', reason: 'task_stopped' };
  }
  if (input.executionCount === 0) return { action: 'skip', reason: 'no_executions' };
  if (!input.runIsComplete && input.hasBlockedExecution) {
    return {
      action: 'blockOnBlockedExecutions',
      blockedReason: input.firstBlockedResult ?? 'One or more workflow agents are blocked',
    };
  }
  if (input.canonicalTaskStatus === 'open' && input.availableTaskSlots <= 0) {
    return { action: 'deferNoAvailableSlots' };
  }
  return { action: 'proceed' };
}

export interface TimedExecutionSnapshot {
  status: string;
  startedAt: number | null;
}

export interface TimedOutExecutionSelection<T extends TimedExecutionSnapshot> {
  timedOutExecutions: T[];
  maxElapsedMs: number;
}

export function selectTimedOutExecutions<T extends TimedExecutionSnapshot>(
  executions: readonly T[],
  taskTimeoutMs: number | undefined,
  now: number
): TimedOutExecutionSelection<T> {
  if (taskTimeoutMs === undefined) {
    return { timedOutExecutions: [], maxElapsedMs: 0 };
  }

  const timedOutExecutions = executions.filter(
    (execution) =>
      execution.status === 'in_progress' &&
      execution.startedAt !== null &&
      now - execution.startedAt > taskTimeoutMs
  );
  const maxElapsedMs = timedOutExecutions.reduce(
    (maxElapsed, execution) => Math.max(maxElapsed, now - (execution.startedAt ?? now)),
    0
  );

  return { timedOutExecutions, maxElapsedMs };
}
