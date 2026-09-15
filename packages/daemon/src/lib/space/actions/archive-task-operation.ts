import type { ArchiveTaskRejection } from '../operations/archive-task.ts';

type ArchiveParams = { task_id: string };

export function mapArchiveRejection(reason: ArchiveTaskRejection | string, taskId: string): string {
  switch (reason) {
    case 'task_not_found':
      return `Task not found: ${taskId}`;
    case 'task_not_in_space':
      return `Task ${taskId} does not belong to this space.`;
    case 'archive_active_run':
      return (
        `Cannot archive task ${taskId}: it belongs to an active workflow run. ` +
        `Cancel the run instead so its agents and lifecycle are torn down — archiving would leave the run stranded.`
      );
    case 'archive_denied':
      return 'archive_task denied: session is not active in the owning space.';
    default:
      return `Task archive failed: ${reason}`;
  }
}

export function mapArchiveTaskParams(params: unknown): { taskId: string } {
  return { taskId: (params as ArchiveParams).task_id };
}

export function mapArchiveTaskResult(
  value: unknown,
  originalParams: unknown
): { success: true; task: unknown } | { success: false; error: string } {
  if (value && typeof value === 'object' && 'id' in value) {
    return { success: true, task: value };
  }
  return {
    success: false,
    error: mapArchiveRejection(
      value as ArchiveTaskRejection,
      (originalParams as ArchiveParams).task_id
    ),
  };
}
