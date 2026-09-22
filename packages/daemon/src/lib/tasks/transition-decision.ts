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
  workflowRunId: string | null;
  runActive: boolean;
  callerSource: OperationCaller['source'];
}
type RejectResult =
  | 'unsupported_status'
  | 'invalid_transition'
  | 'result_requires_done'
  | 'block_reason_requires_blocked'
  | 'approved_requires_complete'
  | 'archive_active_run';
export type SpaceTaskTransitionDecision =
  | { action: 'write'; approvalSource: 'human' | undefined; allowActiveRun: boolean }
  | { action: 'reject'; result: RejectResult }
  | {
      action: 'runtime';
      executor: 'park_stopped' | 'recover_transition' | 'stop_for_status';
      approvalSource: 'human' | undefined;
    };
type Input = SpaceTaskTransitionDecisionInput;
type Gate = { value: TaskUpdateRouting } | { reason: SpaceTaskTransitionDecision };
const RUNTIME_ACTIONS = ['park_stopped', 'recover_transition', 'stop_for_status'] as const;
type RuntimeExecutor = (typeof RUNTIME_ACTIONS)[number];
const REJECT_UNSUPPORTED = { action: 'reject', result: 'unsupported_status' } as const;
const REJECT_INVALID = { action: 'reject', result: 'invalid_transition' } as const;
const REJECT_RESULT_REQUIRES_DONE = { action: 'reject', result: 'result_requires_done' } as const;
const REJECT_BLOCK_REASON_REQUIRES_BLOCKED = {
  action: 'reject',
  result: 'block_reason_requires_blocked',
} as const;
const REJECT_ARCHIVE_ACTIVE_RUN = { action: 'reject', result: 'archive_active_run' } as const;
const REJECT_APPROVED_REQUIRES_COMPLETE = {
  action: 'reject',
  result: 'approved_requires_complete',
} as const;
const REJECT_BY_ROUTING_REASON: Partial<
  Record<TaskUpdateRejectReason, SpaceTaskTransitionDecision>
> = {
  review_to_done: REJECT_INVALID,
  approved_requires_complete: REJECT_APPROVED_REQUIRES_COMPLETE,
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
  return input.requestedStatus === 'done' &&
    (input.currentStatus === 'review' || input.currentStatus === 'approved')
    ? 'human'
    : undefined;
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
  .pipe(requireTableTransition, ['decision', 'input'], 'result:decision')
  .pipe(routeRuntimeAction, ['decision', 'input'], 'result:decision')
  .pipe(stampApproval, 'input', 'decision')
  .end('decision') as (input: SpaceTaskTransitionDecisionInput) => SpaceTaskTransitionDecision;
