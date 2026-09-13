import type { SpaceTask, SpaceTaskStatus } from '@hyperneo/shared';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';

type TaskStatusFields = Pick<
  Parameters<SpaceTaskRepository['updateTask']>[1],
  'result' | 'reportedSummary' | 'blockReason' | 'approvalSource' | 'approvalReason'
>;

export function prepareSpaceTaskStatusUpdate(
  task: SpaceTask,
  newStatus: SpaceTaskStatus,
  options: TaskStatusFields | undefined,
  now: number
) {
  const updates: Parameters<SpaceTaskRepository['updateTask']>[1] = { status: newStatus };

  if (newStatus === 'done' || newStatus === 'blocked') {
    if (options?.result !== undefined) {
      updates.result = options.result;
    } else if (!task.result && options?.reportedSummary !== null) {
      const summary = options?.reportedSummary ?? task.reportedSummary;
      if (summary) updates.result = summary;
    } else if (task.status === 'blocked' && newStatus === 'done') {
      const summary =
        options?.reportedSummary !== undefined ? options.reportedSummary : task.reportedSummary;
      updates.result = summary ?? null;
    }
    if (options?.reportedSummary !== undefined) {
      updates.reportedSummary = options.reportedSummary;
    }
  }

  if (newStatus === 'blocked') {
    updates.blockReason = options?.blockReason ?? null;
  } else if (task.status === 'blocked' && newStatus !== 'stopped') {
    updates.blockReason = null;
  }

  if (task.status === 'review' && newStatus === 'done') {
    updates.approvalSource = options?.approvalSource ?? null;
    updates.approvalReason = options?.approvalReason ?? null;
    updates.approvedAt = now;
  }

  if (newStatus === 'approved') {
    updates.approvalSource = options?.approvalSource ?? null;
    updates.approvalReason = options?.approvalReason ?? null;
    updates.approvedAt = now;
  }

  if (task.status === 'approved' && newStatus === 'done') {
    if (options?.approvalSource !== undefined) {
      updates.approvalSource = options.approvalSource;
    }
    if (options?.approvalReason !== undefined) {
      updates.approvalReason = options.approvalReason;
    }
  }

  if (
    (task.status === 'blocked' && (newStatus === 'open' || newStatus === 'in_progress')) ||
    (task.status === 'cancelled' && (newStatus === 'open' || newStatus === 'in_progress')) ||
    (task.status === 'done' && (newStatus === 'open' || newStatus === 'in_progress')) ||
    (task.status === 'in_progress' && newStatus === 'open') ||
    (task.status === 'review' && (newStatus === 'open' || newStatus === 'in_progress'))
  ) {
    updates.result = null;
    updates.reportedSummary = null;
    updates.blockReason = null;
    updates.approvalSource = null;
    updates.approvalReason = null;
    updates.approvedAt = null;
    updates.postApprovalSourceNodeId = null;
  }

  if (task.status === 'stopped' && (newStatus === 'open' || newStatus === 'in_progress')) {
    updates.reportedStatus = null;
    updates.reportedSummary = null;
    updates.result = null;
    updates.blockReason = null;
  }

  if (
    (task.status === 'review' && newStatus !== 'review' && newStatus !== 'stopped') ||
    newStatus === 'approved'
  ) {
    updates.pendingCheckpointType = null;
    updates.pendingCompletionSubmittedByNodeId = null;
    updates.pendingCompletionSubmittedAt = null;
    updates.pendingCompletionReason = null;
  }

  if (
    task.status === 'review' &&
    newStatus !== 'review' &&
    newStatus !== 'approved' &&
    newStatus !== 'stopped'
  ) {
    updates.postApprovalSourceNodeId = null;
  }

  if (task.status === 'approved' && newStatus !== 'approved') {
    updates.postApprovalSessionId = null;
    updates.postApprovalStartedAt = null;
    updates.postApprovalBlockedReason = null;
    updates.postApprovalSourceNodeId = null;
  }

  const reopened = isTerminalTaskStatus(task.status) && !isTerminalTaskStatus(newStatus);
  if (reopened) {
    updates.postApprovalSessionId = null;
    updates.postApprovalStartedAt = null;
    updates.postApprovalBlockedReason = null;
  }
  if (reopened && newStatus === 'open') {
    updates.startedAt = null;
  }
  return { updates, reopened };
}

export function isTerminalTaskStatus(status: SpaceTaskStatus): boolean {
  return (
    status === 'done' || status === 'blocked' || status === 'cancelled' || status === 'archived'
  );
}

export function prepareSpaceTaskReviewUpdate(
  options: {
    submittedByNodeId: string | null;
    reason: string | null;
    reportedSummary?: string | null;
  },
  now: number
): Parameters<SpaceTaskRepository['updateTask']>[1] {
  return {
    status: 'review',
    pendingCheckpointType: 'task_completion',
    pendingCompletionSubmittedByNodeId: options.submittedByNodeId,
    pendingCompletionSubmittedAt: now,
    pendingCompletionReason: options.reason,
    blockReason: null,
    postApprovalSourceNodeId: options.submittedByNodeId,
    ...(options.reportedSummary !== undefined ? { reportedSummary: options.reportedSummary } : {}),
  };
}
