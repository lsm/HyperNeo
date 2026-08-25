import type { SpaceTaskStatus } from '@hyperneo/shared';
import { isRateOrUsageLimited } from '@hyperneo/shared';
import type { AutonomyAdmissionDenyReason } from './tool-admission-gates.ts';
import { isAgentCeilingBinding } from './tool-admission-gates.ts';

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
  | 'limited_direct'
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
    if (isRateOrUsageLimited(requestedStatus as SpaceTaskStatus)) {
      return {
        action: 'reject',
        reason: 'limited_direct',
        message:
          `update_task cannot transition a task into '${requestedStatus}' directly. ` +
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

export interface CancelTaskRoutingInput {
  cancelWorkflowRunRequested: boolean;
  hasWorkflowRun: boolean;
  runExists: boolean;
}

export type CancelTaskRouting =
  | { action: 'cancel_only' }
  | { action: 'cancel_run'; runExists: boolean };

export function routeCancelTask(input: CancelTaskRoutingInput): CancelTaskRouting {
  if (!input.cancelWorkflowRunRequested || !input.hasWorkflowRun) {
    return { action: 'cancel_only' };
  }
  return { action: 'cancel_run', runExists: input.runExists };
}

export interface PublishTaskRoutingInput extends TaskTargetGateInput {
  currentStatus: string;
}

export type PublishTaskRouting =
  | { action: 'reject'; reason: TaskTargetRejectReason | 'not_draft'; message: string }
  | { action: 'publish' };

export function routePublishTask(input: PublishTaskRoutingInput): PublishTaskRouting {
  const target = routeTaskTarget(input);
  if (target.action === 'reject') {
    return target;
  }
  if (input.currentStatus !== 'draft') {
    return {
      action: 'reject',
      reason: 'not_draft',
      message: `Task is in '${input.currentStatus}' status, not 'draft'. Only draft tasks can be published.`,
    };
  }
  return { action: 'publish' };
}

export interface ArchiveTaskRoutingInput extends TaskTargetGateInput {
  hasWorkflowRun: boolean;
  runActive: boolean;
  workflowRunId?: string;
}

export type ArchiveTaskRouting =
  | { action: 'reject'; reason: TaskTargetRejectReason | 'archive_active_run'; message: string }
  | { action: 'archive' };

export function routeArchiveTask(input: ArchiveTaskRoutingInput): ArchiveTaskRouting {
  const target = routeTaskTarget(input);
  if (target.action === 'reject') {
    return target;
  }
  if (input.hasWorkflowRun && input.runActive) {
    return {
      action: 'reject',
      reason: 'archive_active_run',
      message:
        `Cannot archive task ${input.taskId}: it belongs to an active workflow run ` +
        `(${input.workflowRunId}). Cancel the run instead so its agents and ` +
        `lifecycle are torn down — archiving would leave the run stranded.`,
    };
  }
  return { action: 'archive' };
}

export interface ReassignTaskRoutingInput {
  customAgentId: string | null | undefined;
  workerAgentExists: boolean;
}

export type ReassignTaskRouting =
  | { action: 'reject'; reason: 'worker_agent_not_found'; message: string }
  | { action: 'reassign' };

export function routeReassignTask(input: ReassignTaskRoutingInput): ReassignTaskRouting {
  if (input.customAgentId != null && !input.workerAgentExists) {
    return {
      action: 'reject',
      reason: 'worker_agent_not_found',
      message: `Worker agent not found: ${input.customAgentId}`,
    };
  }
  return { action: 'reassign' };
}

export interface ApproveTaskRoutingInput extends TaskTargetGateInput {
  currentStatus: string;
  level: number;
  required: number;
  agentLevel: number | null;
  spaceLevel: number;
}

export type ApproveTaskRouting =
  | { action: 'reject'; reason: TaskTargetRejectReason | 'not_in_review'; message: string }
  | {
      action: 'deny';
      reason: AutonomyAdmissionDenyReason;
      agentLevel?: number;
      spaceLevel: number;
      required: number;
      message: string;
    }
  | { action: 'approve' };

export function routeApproveTask(input: ApproveTaskRoutingInput): ApproveTaskRouting {
  const target = routeTaskTarget(input);
  if (target.action === 'reject') {
    return target;
  }
  if (input.level < input.required) {
    if (isAgentCeilingBinding(input.spaceLevel, input.agentLevel)) {
      return {
        action: 'deny',
        reason: 'agent_autonomy_ceiling',
        agentLevel: input.agentLevel,
        spaceLevel: input.spaceLevel,
        required: input.required,
        message: `approve_task not permitted: agent autonomy ceiling ${input.agentLevel} (space ${input.spaceLevel}) < workflow completionAutonomyLevel ${input.required}. Use submit_for_approval to request human review.`,
      };
    }
    return {
      action: 'deny',
      reason: 'space_autonomy_level',
      spaceLevel: input.spaceLevel,
      required: input.required,
      message: `approve_task not permitted: space autonomy level ${input.spaceLevel} < workflow completionAutonomyLevel ${input.required}. Use submit_for_approval to request human review.`,
    };
  }
  if (input.currentStatus !== 'review') {
    return {
      action: 'reject',
      reason: 'not_in_review',
      message: `Task is in '${input.currentStatus}' status, not 'review'. Only tasks in review can be approved.`,
    };
  }
  return { action: 'approve' };
}
