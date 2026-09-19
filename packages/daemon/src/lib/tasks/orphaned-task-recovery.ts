import type { SpaceTask } from '@hyperneo/shared';

export const ORPHANED_IN_PROGRESS_GRACE_MS = 120_000;

export interface OrphanedTaskEvidence {
  task: SpaceTask;
  hasDirectAttempt: boolean;
}

export function isOrphanedInProgressTask(evidence: OrphanedTaskEvidence, now: number): boolean {
  const { task, hasDirectAttempt } = evidence;
  if (task.status !== 'in_progress' || task.archivedAt) return false;
  if (task.workflowRunId || task.taskAgentSessionId || hasDirectAttempt) return false;
  const since = task.startedAt ?? task.updatedAt ?? 0;
  return since > 0 && now - since >= ORPHANED_IN_PROGRESS_GRACE_MS;
}

export function selectOrphanedInProgressTasks(
  evidence: OrphanedTaskEvidence[],
  now: number
): SpaceTask[] {
  return evidence
    .filter((candidate) => isOrphanedInProgressTask(candidate, now))
    .map((candidate) => candidate.task);
}
