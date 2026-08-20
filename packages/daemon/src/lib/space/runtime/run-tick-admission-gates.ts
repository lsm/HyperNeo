import type { SpaceTaskStatus, WorkflowRunStatus } from '@hyperneo/shared';
import { decideRunTickAdmissionViaPipeline } from './run-tick-decision-pipeline';

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
  return decideRunTickAdmissionViaPipeline(input);
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
