import { isWorkflowRecoveryTransition, type SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import { isValidTaskTransition } from './transitions.ts';
import {
  routeTaskUpdate,
  type TaskUpdateRejectReason,
  type TaskUpdateRouting,
} from '../space/tools/task-transition-routing.ts';
export interface SpaceTaskTransitionDecisionInput {
  taskId: string;
  currentStatus: SpaceTaskStatus;
  requestedStatus: SpaceTaskStatus;
  hasResult: boolean;
  hasBlockReason: boolean;
  hasReviewReason: boolean;
  workflowRunId: string | null;
  runActive: boolean;
  callerSource: OperationCaller['source'];
  approvalSource: string | null;
}
type RejectResult =
  | 'unsupported_status'
  | 'invalid_transition'
  | 'result_requires_done'
  | 'block_reason_requires_blocked'
  | 'review_reason_requires_review'
  | 'archive_active_run';
export type SpaceTaskTransitionDecision =
  | { action: 'write'; approvalSource: 'human' | undefined; allowActiveRun: boolean }
  | { action: 'reject'; result: RejectResult }
  | {
      action: 'runtime';
      executor:
        | 'park_stopped'
        | 'recover_transition'
        | 'stop_for_status'
        | 'submit_review'
        | 'cancel_task'
        | 'complete_task';
      approvalSource: 'human' | undefined;
    };
type Input = SpaceTaskTransitionDecisionInput;
type Gate = { value: TaskUpdateRouting } | { reason: SpaceTaskTransitionDecision };
const RUNTIME_ACTIONS = [
  'park_stopped',
  'recover_transition',
  'stop_for_status',
  'submit_review',
  'cancel_task',
  'complete_task',
] as const;
type RuntimeExecutor = (typeof RUNTIME_ACTIONS)[number];
const REJECT_UNSUPPORTED = { action: 'reject', result: 'unsupported_status' } as const;
const REJECT_INVALID = { action: 'reject', result: 'invalid_transition' } as const;
const REJECT_RESULT_REQUIRES_DONE = { action: 'reject', result: 'result_requires_done' } as const;
const REJECT_BLOCK_REASON_REQUIRES_BLOCKED = {
  action: 'reject',
  result: 'block_reason_requires_blocked',
} as const;
const REJECT_REVIEW_REASON_REQUIRES_REVIEW = {
  action: 'reject',
  result: 'review_reason_requires_review',
} as const;
const REJECT_ARCHIVE_ACTIVE_RUN = { action: 'reject', result: 'archive_active_run' } as const;
const REJECT_BY_ROUTING_REASON: Partial<
  Record<TaskUpdateRejectReason, SpaceTaskTransitionDecision>
> = {
  review_to_done: REJECT_INVALID,
  archive_active_run: REJECT_ARCHIVE_ACTIVE_RUN,
};
export function classifyRequest(input: Input): TaskUpdateRouting {
  const { currentStatus, requestedStatus, workflowRunId, runActive } = input;
  const statusDiffers = currentStatus !== requestedStatus;
  return routeTaskUpdate({
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
    allowReviewToDone: input.callerSource === 'rpc',
    allowApprovedToDone: input.callerSource === 'rpc',
  });
}
export function rejectUnsupportedRequest(routing: TaskUpdateRouting): Gate {
  if (routing.action === 'fields_only') return { reason: REJECT_INVALID };
  if (routing.action !== 'reject') return { value: routing };
  return { reason: REJECT_BY_ROUTING_REASON[routing.reason] ?? REJECT_UNSUPPORTED };
}
export function requireResultOnlyWithDone(routing: TaskUpdateRouting, input: Input): Gate {
  return input.hasResult && input.requestedStatus !== 'done'
    ? { reason: REJECT_RESULT_REQUIRES_DONE }
    : { value: routing };
}
export function requireBlockReasonOnlyWithBlocked(routing: TaskUpdateRouting, input: Input): Gate {
  return input.hasBlockReason && input.requestedStatus !== 'blocked'
    ? { reason: REJECT_BLOCK_REASON_REQUIRES_BLOCKED }
    : { value: routing };
}
export function requireReviewReasonOnlyWithReview(routing: TaskUpdateRouting, input: Input): Gate {
  return input.hasReviewReason && input.requestedStatus !== 'review'
    ? { reason: REJECT_REVIEW_REASON_REQUIRES_REVIEW }
    : { value: routing };
}
export function routeReviewSubmission(routing: TaskUpdateRouting): Gate {
  return routing.action === 'submit_review'
    ? { reason: { action: 'runtime', executor: 'submit_review', approvalSource: undefined } }
    : { value: routing };
}
export function routeCancellation(routing: TaskUpdateRouting): Gate {
  return routing.action === 'cancel_task'
    ? { reason: { action: 'runtime', executor: 'cancel_task', approvalSource: undefined } }
    : { value: routing };
}
export function routeCompletion(routing: TaskUpdateRouting): Gate {
  return routing.action === 'complete_task'
    ? { reason: { action: 'runtime', executor: 'complete_task', approvalSource: undefined } }
    : { value: routing };
}
export function requireTableTransition(routing: TaskUpdateRouting, input: Input): Gate {
  return isValidTaskTransition(input.currentStatus, input.requestedStatus)
    ? { value: routing }
    : { reason: REJECT_INVALID };
}
export function routeRuntimeAction(routing: TaskUpdateRouting, input: Input): Gate {
  return (RUNTIME_ACTIONS as readonly string[]).includes(routing.action)
    ? {
        reason: {
          action: 'runtime',
          executor: routing.action as RuntimeExecutor,
          approvalSource: resolveApprovalSource(input),
        },
      }
    : { value: routing };
}
function resolveApprovalSource(input: Input): 'human' | undefined {
  if (input.requestedStatus !== 'done') return undefined;
  if (input.currentStatus !== 'review' && input.currentStatus !== 'approved') return undefined;
  return input.approvalSource ? undefined : 'human';
}
export function allowsWriteBesideActiveRun(input: Input): boolean {
  return (
    input.requestedStatus === 'in_progress' &&
    (input.currentStatus === 'review' || input.currentStatus === 'approved')
  );
}
export function stampApproval(input: Input): SpaceTaskTransitionDecision {
  return {
    action: 'write',
    approvalSource: resolveApprovalSource(input),
    allowActiveRun: allowsWriteBesideActiveRun(input),
  };
}
export const decideSpaceTaskTransition = (superpipe({})('space-task-transition') as PipelineAPI)
  .input('input')
  .pipe(classifyRequest, 'input', 'routing')
  .pipe(rejectUnsupportedRequest, 'routing', 'result:decision')
  .pipe(requireResultOnlyWithDone, ['decision', 'input'], 'result:decision')
  .pipe(requireBlockReasonOnlyWithBlocked, ['decision', 'input'], 'result:decision')
  .pipe(requireReviewReasonOnlyWithReview, ['decision', 'input'], 'result:decision')
  .pipe(routeReviewSubmission, 'decision', 'result:decision')
  .pipe(routeCancellation, 'decision', 'result:decision')
  .pipe(routeCompletion, 'decision', 'result:decision')
  .pipe(requireTableTransition, ['decision', 'input'], 'result:decision')
  .pipe(routeRuntimeAction, ['decision', 'input'], 'result:decision')
  .pipe(stampApproval, 'input', 'decision')
  .end('decision') as (input: SpaceTaskTransitionDecisionInput) => SpaceTaskTransitionDecision;
