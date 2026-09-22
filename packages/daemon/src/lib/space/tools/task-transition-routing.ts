import type { SpaceTaskStatus } from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';

export interface TaskUpdateRoutingInput {
  hasChanges: boolean;
  taskExists: boolean;
  taskInSpace: boolean;
  currentStatus: string;
  requestedStatus: string | undefined;
  statusDiffers: boolean;
  hasWorkflowRun: boolean;
  runActive: boolean;
  isRecoveryTransition: boolean;
  hasFieldUpdates: boolean;
  taskId: string;
  workflowRunId?: string;
  allowReviewToDone?: boolean;
  allowApprovedToDone?: boolean;
}

export type TaskUpdateRejectReason =
  | 'no_updatable_fields'
  | 'task_not_found'
  | 'task_not_in_space'
  | 'review_direct'
  | 'approved_direct'
  | 'limited_direct'
  | 'review_to_done'
  | 'approved_requires_complete'
  | 'archive_active_run';

export type TaskUpdateRouting =
  | { action: 'reject'; reason: TaskUpdateRejectReason; message: string }
  | {
      action: 'park_stopped';
      auditParamsShape: 'transition';
      emitTaskUpdated: 'only_with_field_updates';
    }
  | {
      action: 'recover_transition';
      auditParamsShape: 'transition';
      emitTaskUpdated: 'only_with_field_updates';
    }
  | { action: 'stop_for_status'; auditParamsShape: 'transition'; emitTaskUpdated: 'never' }
  | { action: 'set_status'; auditParamsShape: 'transition'; emitTaskUpdated: 'always' }
  | { action: 'fields_only'; auditParamsShape: 'fields_only'; emitTaskUpdated: 'always' };

export type TaskTargetRejectReason = 'task_not_found' | 'task_not_in_space';

export interface TaskTargetGateInput {
  taskExists: boolean;
  taskInSpace: boolean;
  taskId: string;
}

export type TaskTargetGate =
  | { action: 'reject'; reason: TaskTargetRejectReason; message: string }
  | { action: 'proceed' };

export function routeTaskTarget(input: TaskTargetGateInput): TaskTargetGate {
  if (!input.taskExists) {
    return {
      action: 'reject',
      reason: 'task_not_found',
      message: `Task not found: ${input.taskId}`,
    };
  }
  if (!input.taskInSpace) {
    return {
      action: 'reject',
      reason: 'task_not_in_space',
      message: `Task ${input.taskId} does not belong to this space.`,
    };
  }
  return { action: 'proceed' };
}

export function routeTaskUpdate(input: TaskUpdateRoutingInput): TaskUpdateRouting {
  const {
    hasChanges,
    currentStatus,
    requestedStatus,
    statusDiffers,
    hasWorkflowRun,
    runActive,
    isRecoveryTransition,
    taskId,
    workflowRunId,
    allowReviewToDone,
    allowApprovedToDone,
  } = input;
  if (!hasChanges) {
    return {
      action: 'reject',
      reason: 'no_updatable_fields',
      message:
        'No fields to update. Provide at least one of: title, description, priority, depends_on, status.',
    };
  }
  const target = routeTaskTarget(input);
  if (target.action === 'reject') {
    return target;
  }
  if (requestedStatus !== undefined && statusDiffers) {
    if (requestedStatus === 'review') {
      return {
        action: 'reject',
        reason: 'review_direct',
        message:
          `Cannot transition a task into 'review' directly. ` +
          `Use task.submitForReview so the pending-completion fields get stamped ` +
          `and the approval banner renders.`,
      };
    }
    if (requestedStatus === 'approved') {
      return {
        action: 'reject',
        reason: 'approved_direct',
        message:
          `Cannot transition a task into 'approved' directly. ` +
          `Use task.approve after task.submitForReview, or let the ` +
          `runtime's post-approval router handle the transition — both stamp ` +
          `the approval metadata and dispatch the configured post-approval step.`,
      };
    }
    if (isRateOrUsageLimited(requestedStatus as SpaceTaskStatus)) {
      return {
        action: 'reject',
        reason: 'limited_direct',
        message:
          `Cannot transition a task into '${requestedStatus}' directly. ` +
          `rate_limited and usage_limited are runtime-owned: the rate-limit pause ` +
          `path sets them with a restrictions payload and the resume path clears ` +
          `them automatically.`,
      };
    }
    if (requestedStatus === 'stopped' && hasWorkflowRun) {
      return {
        action: 'park_stopped',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      };
    }
    if (requestedStatus === 'done' && currentStatus === 'review' && !allowReviewToDone) {
      return {
        action: 'reject',
        reason: 'review_to_done',
        message:
          `Cannot transition a task from 'review' to 'done' directly. ` +
          `Use task.approve (subject to the workflow's completion ` +
          `autonomy level) or task.submitForReview so a human can approve via the UI — ` +
          `both stamp the approval metadata and dispatch the configured post-approval step.`,
      };
    }
    if (requestedStatus === 'done' && currentStatus === 'approved' && !allowApprovedToDone) {
      return {
        action: 'reject',
        reason: 'approved_requires_complete',
        message:
          `Cannot close approved task ${taskId} through a status change. ` +
          `Use task.complete, which fences the transition on the routed post-approval ` +
          `session and applies the workflow's completion gate — for a coder-owned-merge ` +
          `workflow that gate holds the task open until its pull request is merged.`,
      };
    }
    if (requestedStatus === 'archived' && hasWorkflowRun && runActive) {
      return {
        action: 'reject',
        reason: 'archive_active_run',
        message:
          `Cannot archive task ${taskId}: it belongs to an active workflow run ` +
          `(${workflowRunId}). Cancel the task instead (task.cancel) so its ` +
          `agents and lifecycle are torn down — archiving would leave the run stranded.`,
      };
    }
    if (hasWorkflowRun && isRecoveryTransition) {
      return {
        action: 'recover_transition',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      };
    }
    const rateOrUsageLimited = isRateOrUsageLimited(currentStatus as SpaceTaskStatus);
    const fromActivePaused =
      currentStatus === 'in_progress' ||
      currentStatus === 'blocked' ||
      currentStatus === 'stopped' ||
      rateOrUsageLimited;
    const toStopped = requestedStatus === 'open' || requestedStatus === 'cancelled';
    const toBlockedFromPaused = requestedStatus === 'blocked' && rateOrUsageLimited;
    const toTerminalWithActiveRun =
      runActive && (requestedStatus === 'done' || requestedStatus === 'blocked');
    if (
      hasWorkflowRun &&
      (toTerminalWithActiveRun || (fromActivePaused && (toStopped || toBlockedFromPaused)))
    ) {
      return {
        action: 'stop_for_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'never',
      };
    }
    return {
      action: 'set_status',
      auditParamsShape: 'transition',
      emitTaskUpdated: 'always',
    };
  }
  return {
    action: 'fields_only',
    auditParamsShape: 'fields_only',
    emitTaskUpdated: 'always',
  };
}

export interface RetryTaskRoutingInput extends TaskTargetGateInput {
  currentStatus: string;
  hasWorkflowRun: boolean;
}

export type RetryTaskRouting =
  | { action: 'reject'; reason: TaskTargetRejectReason | 'status_not_retryable'; message: string }
  | { action: 'recover_workflow_task'; targetStatus: 'open' | 'in_progress' }
  | { action: 'retry_task' };

export function routeRetryTask(input: RetryTaskRoutingInput): RetryTaskRouting {
  const target = routeTaskTarget(input);
  if (target.action === 'reject') {
    return target;
  }
  if (input.hasWorkflowRun) {
    const retryableStatuses = ['blocked', 'cancelled', 'done'];
    if (!retryableStatuses.includes(input.currentStatus)) {
      return {
        action: 'reject',
        reason: 'status_not_retryable',
        message: `Cannot retry task in '${input.currentStatus}' status. Task must be in 'blocked', 'cancelled', or 'done' status.`,
      };
    }
    return {
      action: 'recover_workflow_task',
      targetStatus: input.currentStatus === 'blocked' ? 'open' : 'in_progress',
    };
  }
  return { action: 'retry_task' };
}
