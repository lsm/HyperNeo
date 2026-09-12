import { isWorkflowRecoveryTransition, type SpaceTaskStatus } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../../operations/registry.ts';
import { isValidTaskTransition } from '../../tasks/transitions.ts';
import { routeTaskUpdate, type TaskUpdateRouting } from '../tools/task-transition-routing.ts';
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
type Input = SpaceTaskTransitionDecisionInput;
type Gate = { value: TaskUpdateRouting } | { reason: SpaceTaskTransitionDecision };
const RUNTIME_ACTIONS = ['park_stopped', 'recover_transition', 'stop_for_status'] as const;
type RuntimeExecutor = (typeof RUNTIME_ACTIONS)[number];
const REJECT_UNSUPPORTED = { action: 'reject', result: 'unsupported_status' } as const;
const REJECT_INVALID = { action: 'reject', result: 'invalid_transition' } as const;
const REJECT_RESULT_REQUIRES_DONE = { action: 'reject', result: 'result_requires_done' } as const;
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
  });
}
export function rejectUnsupportedRequest(routing: TaskUpdateRouting, input: Input): Gate {
  if (routing.action === 'fields_only') return { reason: REJECT_INVALID };
  if (routing.action !== 'reject') return { value: routing };
  if (routing.reason !== 'review_to_done') return { reason: REJECT_UNSUPPORTED };
  return input.callerSource !== 'rpc' ? { reason: REJECT_INVALID } : { value: routing };
}
export function requireResultOnlyWithDone(routing: TaskUpdateRouting, input: Input): Gate {
  return input.hasResult && input.requestedStatus !== 'done'
    ? { reason: REJECT_RESULT_REQUIRES_DONE }
    : { value: routing };
}
export function requireTableTransition(routing: TaskUpdateRouting, input: Input): Gate {
  return isValidTaskTransition(input.currentStatus, input.requestedStatus)
    ? { value: routing }
    : { reason: REJECT_INVALID };
}
export function routeRuntimeAction(routing: TaskUpdateRouting): Gate {
  return (RUNTIME_ACTIONS as readonly string[]).includes(routing.action)
    ? { reason: { action: 'runtime', executor: routing.action as RuntimeExecutor } }
    : { value: routing };
}
export function stampApproval(input: Input): SpaceTaskTransitionDecision {
  const approvalSource =
    input.currentStatus === 'review' && input.requestedStatus === 'done' ? 'human' : undefined;
  return { action: 'write', approvalSource };
}
export const decideSpaceTaskTransition = (superpipe({})('space-task-transition') as PipelineAPI)
  .input('input')
  .pipe(classifyRequest, 'input', 'routing')
  .pipe(rejectUnsupportedRequest, ['routing', 'input'], 'result:decision')
  .pipe(requireResultOnlyWithDone, ['decision', 'input'], 'result:decision')
  .pipe(requireTableTransition, ['decision', 'input'], 'result:decision')
  .pipe(routeRuntimeAction, 'decision', 'result:decision')
  .pipe(stampApproval, 'input', 'decision')
  .end('decision') as (input: SpaceTaskTransitionDecisionInput) => SpaceTaskTransitionDecision;
