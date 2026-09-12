import { isWorkflowRecoveryTransition, type SpaceTaskStatus } from '@hyperneo/shared';
import type { OperationCaller } from '../../operations/registry.ts';
import { isValidTaskTransition } from '../../tasks/transitions.ts';
import { routeTaskUpdate } from '../tools/task-transition-routing.ts';

export interface SpaceTaskTransitionDecisionInput {
  taskId: string;
  currentStatus: SpaceTaskStatus;
  requestedStatus: SpaceTaskStatus;
  hasResult: boolean;
  workflowRunId: string | null;
  runActive: boolean;
  callerSource: OperationCaller['source'];
}

type RejectResult = 'unsupported_status' | 'invalid_transition' | 'result_requires_done';

export type SpaceTaskTransitionDecision =
  | { action: 'write'; approvalSource: 'human' | undefined }
  | { action: 'reject'; result: RejectResult }
  | { action: 'runtime'; executor: 'park_stopped' | 'recover_transition' | 'stop_for_status' };

const RUNTIME_ACTIONS = ['park_stopped', 'recover_transition', 'stop_for_status'] as const;
const REJECT_UNSUPPORTED = { action: 'reject', result: 'unsupported_status' } as const;
const REJECT_INVALID = { action: 'reject', result: 'invalid_transition' } as const;
const REJECT_RESULT_REQUIRES_DONE = { action: 'reject', result: 'result_requires_done' } as const;

export function decideSpaceTaskTransition(
  input: SpaceTaskTransitionDecisionInput
): SpaceTaskTransitionDecision {
  const { currentStatus, requestedStatus, hasResult, workflowRunId, runActive } = input;
  const statusDiffers = currentStatus !== requestedStatus;
  const routing = routeTaskUpdate({
    hasChanges: true,
    taskExists: true,
    taskInSpace: true,
    currentStatus,
    requestedStatus,
    statusDiffers,
    hasWorkflowRun: workflowRunId !== null,
    runActive: workflowRunId !== null && runActive,
    isRecoveryTransition:
      statusDiffers && isWorkflowRecoveryTransition(currentStatus, requestedStatus),
    hasFieldUpdates: false,
    taskId: input.taskId,
    workflowRunId: workflowRunId ?? undefined,
  });
  if (routing.action === 'reject') {
    if (routing.reason !== 'review_to_done') return REJECT_UNSUPPORTED;
    if (input.callerSource !== 'rpc') return REJECT_INVALID;
  } else if ((RUNTIME_ACTIONS as readonly string[]).includes(routing.action)) {
    return { action: 'runtime', executor: routing.action as (typeof RUNTIME_ACTIONS)[number] };
  } else if (routing.action === 'fields_only') return REJECT_INVALID;
  if (hasResult && requestedStatus !== 'done') return REJECT_RESULT_REQUIRES_DONE;
  if (!isValidTaskTransition(currentStatus, requestedStatus)) return REJECT_INVALID;
  const approvalSource =
    currentStatus === 'review' && requestedStatus === 'done' ? 'human' : undefined;
  return { action: 'write', approvalSource };
}
