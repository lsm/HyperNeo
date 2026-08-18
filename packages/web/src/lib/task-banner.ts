import type { SpaceTask } from '@hyperneo/shared';

export type TaskBannerInput = Pick<
  SpaceTask,
  'status' | 'postApprovalBlockedReason' | 'pendingCheckpointType' | 'workflowRunId'
>;

export type HookBannerStatus = 'allowed' | 'blocked_by_hook' | 'waiting_on_hook_retry';

export interface HookBannerSummary {
  status: HookBannerStatus;
  hookId?: string;
  state?: Record<string, unknown>;
}

export type ActiveTaskBanner =
  | { kind: 'blocked' }
  | { kind: 'post_approval_blocked'; reason: string }
  | { kind: 'task_completion_pending' }
  | { kind: 'hook_pending'; runId: string }
  | null;

export function resolveActiveTaskBanner(
  task: TaskBannerInput,
  hooks?: readonly HookBannerSummary[]
): ActiveTaskBanner {
  if (task.status === 'blocked') {
    return { kind: 'blocked' };
  }

  if (task.status === 'approved') {
    const reason = task.postApprovalBlockedReason?.trim();
    if (reason) {
      return { kind: 'post_approval_blocked', reason };
    }
  }

  if (task.pendingCheckpointType === 'task_completion' && task.status === 'review') {
    return { kind: 'task_completion_pending' };
  }

  if (
    task.workflowRunId &&
    hooks &&
    hooks.some((h) => h.status === 'blocked_by_hook' || h.status === 'waiting_on_hook_retry')
  ) {
    return { kind: 'hook_pending', runId: task.workflowRunId };
  }

  return null;
}
