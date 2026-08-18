import type { WorkflowRunStatus } from '@hyperneo/shared';

export const VALID_TRANSITIONS: Readonly<
  Record<WorkflowRunStatus, ReadonlySet<WorkflowRunStatus>>
> = {
  pending: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
  in_progress: new Set<WorkflowRunStatus>(['done', 'blocked', 'cancelled']),
  blocked: new Set<WorkflowRunStatus>(['in_progress', 'cancelled']),
  done: new Set<WorkflowRunStatus>(['in_progress']),
  cancelled: new Set<WorkflowRunStatus>(['in_progress']),
};

export function canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

export function assertValidTransition(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  runId?: string
): void {
  if (!canTransition(from, to)) {
    const ctx = runId ? ` (run ${runId})` : '';
    throw new Error(
      `Invalid workflow run status transition${ctx}: '${from}' → '${to}'. ` +
        `Allowed from '${from}': [${[...VALID_TRANSITIONS[from]].join(', ') || 'none'}]`
    );
  }
}
