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
}

export type TaskUpdateRejectReason =
  | 'no_updatable_fields'
  | 'task_not_found'
  | 'task_not_in_space'
  | 'review_direct'
  | 'approved_direct'
  | 'review_to_done'
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

export interface CreateTaskWorkflowRefInput {
  workflowIdArg: string | null;
  workflowIdUsable: boolean;
  hasHandleArg: boolean;
  trimmedHandle: string;
  handleWorkflowId: string | null;
  handleWorkflowDisabled: boolean;
}

export type CreateTaskWorkflowRef =
  | { action: 'reject'; message: string }
  | { action: 'use_ref'; preferredWorkflowId: string | null };

export function routeCreateTaskWorkflowRef(
  input: CreateTaskWorkflowRefInput
): CreateTaskWorkflowRef {
  const {
    workflowIdArg,
    workflowIdUsable,
    hasHandleArg,
    trimmedHandle,
    handleWorkflowId,
    handleWorkflowDisabled,
  } = input;
  if (workflowIdArg) {
    if (workflowIdUsable) {
      return { action: 'use_ref', preferredWorkflowId: workflowIdArg };
    }
    if (hasHandleArg) {
      if (trimmedHandle === '') {
        return { action: 'reject', message: 'workflow_handle must be a non-empty string.' };
      }
      if (handleWorkflowId !== null) {
        if (handleWorkflowDisabled) {
          return { action: 'reject', message: `Workflow is disabled: ${trimmedHandle}` };
        }
        return { action: 'use_ref', preferredWorkflowId: handleWorkflowId };
      }
      return { action: 'reject', message: `Workflow not found by id or handle: ${trimmedHandle}` };
    }
    return { action: 'use_ref', preferredWorkflowId: workflowIdArg };
  }
  if (hasHandleArg) {
    if (trimmedHandle === '') {
      return { action: 'reject', message: 'workflow_handle must be a non-empty string.' };
    }
    if (handleWorkflowId === null) {
      return { action: 'reject', message: `Workflow not found by handle: ${trimmedHandle}` };
    }
    if (handleWorkflowDisabled) {
      return { action: 'reject', message: `Workflow is disabled: ${trimmedHandle}` };
    }
    return { action: 'use_ref', preferredWorkflowId: handleWorkflowId };
  }
  return { action: 'use_ref', preferredWorkflowId: null };
}

export function routeTaskUpdate(input: TaskUpdateRoutingInput): TaskUpdateRouting {
  const {
    hasChanges,
    taskExists,
    taskInSpace,
    currentStatus,
    requestedStatus,
    statusDiffers,
    hasWorkflowRun,
    runActive,
    isRecoveryTransition,
    taskId,
    workflowRunId,
  } = input;
  if (!hasChanges) {
    return {
      action: 'reject',
      reason: 'no_updatable_fields',
      message:
        'No fields to update. Provide at least one of: title, description, priority, depends_on, status.',
    };
  }
  if (!taskExists) {
    return {
      action: 'reject',
      reason: 'task_not_found',
      message: `Task not found: ${taskId}`,
    };
  }
  if (!taskInSpace) {
    return {
      action: 'reject',
      reason: 'task_not_in_space',
      message: `Task ${taskId} does not belong to this space.`,
    };
  }
  if (requestedStatus !== undefined && statusDiffers) {
    if (requestedStatus === 'review') {
      return {
        action: 'reject',
        reason: 'review_direct',
        message:
          `update_task cannot transition a task into 'review' directly. ` +
          `Use submit_for_approval so the pending-completion fields get stamped ` +
          `and the approval banner renders.`,
      };
    }
    if (requestedStatus === 'approved') {
      return {
        action: 'reject',
        reason: 'approved_direct',
        message:
          `update_task cannot transition a task into 'approved' directly. ` +
          `Use approve_pending_completion after submit_for_approval, or let the ` +
          `runtime's post-approval router handle the transition — both stamp ` +
          `the approval metadata and dispatch the configured post-approval step.`,
      };
    }
    if (requestedStatus === 'stopped' && hasWorkflowRun) {
      return {
        action: 'park_stopped',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      };
    }
    if (requestedStatus === 'done' && currentStatus === 'review') {
      return {
        action: 'reject',
        reason: 'review_to_done',
        message:
          `update_task cannot transition a task from 'review' to 'done' directly. ` +
          `Use approve_task (subject to the workflow's completion autonomy level) ` +
          `or submit_for_approval so a human can approve via the UI — both stamp ` +
          `the approval metadata and dispatch the configured post-approval step.`,
      };
    }
    if (requestedStatus === 'archived' && hasWorkflowRun && runActive) {
      return {
        action: 'reject',
        reason: 'archive_active_run',
        message:
          `Cannot archive task ${taskId}: it belongs to an active workflow run ` +
          `(${workflowRunId}). Cancel the task instead (cancel_task) so its ` +
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
    if (hasWorkflowRun && fromActivePaused && (toStopped || toBlockedFromPaused)) {
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
