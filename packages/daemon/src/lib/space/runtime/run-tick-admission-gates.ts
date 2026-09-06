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
