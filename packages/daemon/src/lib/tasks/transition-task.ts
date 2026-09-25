import type { TaskMutationDenial } from './mutation-denial.ts';
import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { DirectTaskExecutionRepository } from '../../storage/repositories/direct-task-execution-repository.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../storage/repositories/space-task-repository.ts';
import { Logger } from '../logger.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { availableTaskSlots, occupiesTaskSlot } from './capacity.ts';
import {
  type SpaceTaskManager,
  StaleTaskGuardError,
  type TaskTransitionExpectation,
} from './task-manager.ts';
import { decideSpaceTaskTransition } from './transition-decision.ts';
import { createTransitionTaskOperation } from './transition-operation.ts';
import type { DirectOutcomeAcknowledgement } from './direct-outcome-jobs.ts';
import { admitManagedSubmission, admitSubmission } from './submit-for-review.ts';
import {
  admitCancellation,
  admitManagedCancellation,
  type CancelPolicyContext,
} from './cancel-task.ts';
import type { TaskCompletion } from './complete-task.ts';
import {
  admitCaller,
  type Gate,
  loadTask,
  type OwnedTask,
  routeActiveDirectAttempt,
  requireExpectedStatus,
  resolveOwner,
  type SpaceTransitionAdmissionDependencies,
  type SpaceTransitionTaskInput,
  SpaceTransitionTaskInputSchema,
} from './transition-task-admission.ts';

const log = new Logger('SpaceTransitionTask');
type In = SpaceTransitionTaskInput;
type Caller = OperationCaller;
type Rejection =
  | 'unsupported_status'
  | 'direct_attempt_not_running'
  | 'invalid_transition'
  | 'result_requires_done'
  | 'block_reason_requires_blocked'
  | 'review_reason_requires_review'
  | 'space_at_task_capacity'
  | 'archive_active_run';
type Result = TaskCore | Rejection | TaskMutationDenial | DirectOutcomeAcknowledgement | null;
export interface SpaceTransitionTaskDependencies extends SpaceTransitionAdmissionDependencies {
  getTaskManager: (
    spaceId: string
  ) => Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus' | 'submitTaskForReview'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  isWorkflowRunActive: (workflowRunId: string) => boolean;
  recoverTransition?: (
    spaceId: string,
    taskId: string,
    status: 'open' | 'in_progress',
    expected: TaskTransitionExpectation
  ) => Promise<TaskCore | string>;
  stopForStatus?: (
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams,
    expected: TaskTransitionExpectation
  ) => Promise<SpaceTask | null>;
  parkStopped?: (
    spaceId: string,
    taskId: string,
    expected: TaskTransitionExpectation
  ) => Promise<SpaceTask>;
  completeTask?: TaskCompletion;
}
type Deps = SpaceTransitionTaskDependencies;
type DecidedTask = OwnedTask & {
  approvalSource: 'human' | undefined;
  allowActiveRun: boolean;
};
type RuntimeExecutor =
  | 'park_stopped'
  | 'recover_transition'
  | 'stop_for_status'
  | 'submit_review'
  | 'cancel_task'
  | 'complete_task';

function cancelPolicy({ spaceId, task }: OwnedTask, deps: Deps): CancelPolicyContext {
  const expected = {
    expectedStatus: task.status,
    expectedWorkflowRunId: task.workflowRunId ?? null,
  };
  return {
    ...deps,
    getTaskManager: deps.getTaskManager,
    emitTaskUpdated: (id, updated) => deps.emitTaskUpdated(id, updated),
    stopForStatus: deps.stopForStatus
      ? (_spaceId, taskId, params) => deps.stopForStatus!(spaceId, taskId, params, expected)
      : undefined,
  };
}

async function cancelTask(
  owned: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Promise<Result> {
  const policy = cancelPolicy(owned, deps);
  const request = { taskId: owned.task.id };
  const managed = await admitManagedCancellation(deps.db, request, caller, policy);
  if ('reason' in managed) return managed.reason;
  const direct = admitCancellation(deps.db, request, caller, policy);
  if ('reason' in direct) return direct.reason;
  if (!deps.requestDirectOutcome)
    return { accepted: false, reason: 'direct_cancellation_unavailable' };
  return deps.requestDirectOutcome(direct.value);
}

async function submitForReview(
  { task }: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Promise<Result> {
  const request = { taskId: task.id, reason: input.reviewReason ?? null };
  const managed = await admitManagedSubmission(deps.db, request, caller, deps);
  if ('reason' in managed) return managed.reason;
  const direct = admitSubmission(deps.db, request, caller);
  if ('reason' in direct) return direct.reason;
  if (!deps.requestDirectOutcome)
    return { accepted: false, reason: 'direct_review_submission_unavailable' };
  return deps.requestDirectOutcome(direct.value);
}

async function complete(
  { task }: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Promise<Result> {
  if (!deps.completeTask) return { accepted: false, reason: 'task_completion_unavailable' };
  const outcome = await deps.completeTask(
    { taskId: task.id, ...(input.result === undefined ? {} : { result: input.result }) },
    caller
  );
  return outcome.accepted ? outcome.task : outcome;
}

async function runRuntimeExecutor(
  executor: RuntimeExecutor,
  owned: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps,
  approvalSource: 'human' | undefined
): Promise<Result> {
  const { spaceId, task } = owned;
  if (executor === 'submit_review') return submitForReview(owned, input, caller, deps);
  if (executor === 'cancel_task') return cancelTask(owned, input, caller, deps);
  if (executor === 'complete_task') return complete(owned, input, caller, deps);
  const expected = {
    expectedStatus: task.status,
    expectedWorkflowRunId: task.workflowRunId ?? null,
  };
  if (executor === 'park_stopped') {
    if (!deps.parkStopped) throw new Error(`Space runtime executor unavailable: ${executor}`);
    return deps.parkStopped(spaceId, task.id, expected);
  }
  if (executor === 'recover_transition') {
    if (!deps.recoverTransition) throw new Error(`Space runtime executor unavailable: ${executor}`);
    const recovered = await deps.recoverTransition(
      spaceId,
      task.id,
      input.status as 'open' | 'in_progress',
      expected
    );
    return typeof recovered === 'string' ? 'invalid_transition' : recovered;
  }
  if (!deps.stopForStatus) throw new Error(`Space runtime executor unavailable: ${executor}`);
  const stopped = await deps.stopForStatus(
    spaceId,
    task.id,
    {
      status: input.status,
      result: input.result,
      blockReason: input.blockReason,
      approvalSource,
    },
    expected
  );
  return stopped ?? 'invalid_transition';
}

async function snapshotStillCurrent({ spaceId, task }: OwnedTask, deps: Deps): Promise<boolean> {
  const current = await deps.getTaskManager(spaceId).getTask(task.id);
  return (
    current !== null &&
    current.status === task.status &&
    (current.workflowRunId ?? null) === (task.workflowRunId ?? null)
  );
}

export function routeAgentCompletionToReview(owned: OwnedTask, input: In, caller: Caller): In {
  if (caller.source === 'rpc' || input.status !== 'done') return input;
  if (owned.task.status === 'review' || owned.task.status === 'approved') return input;
  return {
    ...input,
    status: 'review',
    reviewReason: input.reviewReason ?? input.result,
    result: undefined,
  };
}

export async function decide(
  owned: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Promise<Gate<DecidedTask, Result>> {
  const { task } = owned;
  const runActive = task.workflowRunId ? deps.isWorkflowRunActive(task.workflowRunId) : false;
  const decision = decideSpaceTaskTransition({
    taskId: input.taskId,
    currentStatus: task.status,
    requestedStatus: input.status,
    hasResult: input.result !== undefined,
    hasBlockReason: input.blockReason !== undefined,
    hasReviewReason: input.reviewReason !== undefined,
    workflowRunId: task.workflowRunId ?? null,
    runActive,
    callerSource: caller.source,
    approvalSource: task.approvalSource ?? null,
  });
  if (decision.action === 'reject') return { reason: decision.result };
  if (decision.action === 'runtime') {
    if (!(await snapshotStillCurrent(owned, deps))) return { reason: 'invalid_transition' };
    try {
      return {
        reason: await runRuntimeExecutor(
          decision.executor,
          owned,
          input,
          caller,
          deps,
          decision.approvalSource
        ),
      };
    } catch (error) {
      if (error instanceof StaleTaskGuardError) return { reason: 'invalid_transition' };
      throw error;
    }
  }
  return {
    value: {
      ...owned,
      approvalSource: decision.approvalSource,
      allowActiveRun: decision.allowActiveRun,
    },
  };
}
export function requireFreeTaskSlot(
  decided: DecidedTask,
  input: In,
  deps: Deps
): Gate<DecidedTask, Result> {
  const { spaceId, task } = decided;
  if (
    input.status !== 'in_progress' ||
    occupiesTaskSlot(task.status) ||
    task.workflowRunId ||
    task.taskAgentSessionId
  )
    return { value: decided };
  const space = new SpaceRepository(deps.db).getSpace(spaceId);
  const tasks = new SpaceTaskRepository(deps.db).listBySpace(spaceId, false);
  return availableTaskSlots(space, tasks) > 0
    ? { value: decided }
    : { reason: 'space_at_task_capacity' };
}
async function emitUpdated(spaceId: string, task: SpaceTask, deps: Deps): Promise<void> {
  await deps
    .emitTaskUpdated(spaceId, task)
    .catch((error: unknown) => log.warn('Failed to emit space.task.updated:', error));
}
function guardActiveExecution(
  deps: Deps,
  allowActiveRun: boolean
): (current: SpaceTask) => string | undefined {
  return (current) => {
    if (new DirectTaskExecutionRepository(deps.db).getActive(current.id)) {
      return 'active_direct_attempt';
    }
    if (
      !allowActiveRun &&
      current.workflowRunId &&
      deps.isWorkflowRunActive(current.workflowRunId)
    ) {
      return 'active_workflow_run';
    }
    return undefined;
  };
}
export async function writeStatus(decided: DecidedTask, input: In, deps: Deps): Promise<Result> {
  const { spaceId, task, approvalSource, allowActiveRun } = decided;
  try {
    const updated = await deps.getTaskManager(spaceId).setTaskStatus(task.id, input.status, {
      result: input.result,
      blockReason: input.blockReason,
      approvalSource,
      expectedStatus: task.status,
      expectedWorkflowRunId: task.workflowRunId ?? null,
      guardWrite: guardActiveExecution(deps, allowActiveRun),
      onCascadedTasks: async (cascaded) => {
        for (const cascadedTask of cascaded) await emitUpdated(spaceId, cascadedTask, deps);
      },
    });
    await emitUpdated(spaceId, updated, deps);
    return updated;
  } catch (error) {
    if (error instanceof StaleTaskGuardError) {
      return 'invalid_transition';
    }
    throw error;
  }
}
const SPACE_TRANSITION_TASK_DESCRIPTION =
  'Space-scoped callers change the lifecycle state of a task in their Space; approved is entered only through the approval operations, and rate_limited/usage_limited are runtime-owned. Moving a task to review stamps the pending-completion checkpoint the approval banner renders from rather than writing the status directly, so it is the one transition that is also legal from review itself: re-submitting refreshes a task_completion checkpoint and rejects review_submission_invalid_transition for any other checkpoint type. reviewReason may accompany only a transition to review. A direct-execution task submits through the same durable outcome queue as the other terminal statuses and returns { accepted, jobId }, rejecting direct_review_submission_unavailable when no attempt backs the task and direct_review_submission_denied when the calling MCP session is not the attempt’s own worker; every other Space-owned task is stamped synchronously and returns { accepted: true, jobId: null }, rejecting review_submission_unavailable when the task is missing or archived and review_submission_denied when the calling MCP session is not active in the owning Space. A running direct-execution attempt moving to done, blocked, or stopped is shut down through the durable outcome queue before the task status commits; that route returns { accepted, jobId } instead of task data. Moving a task to cancelled runs the cancellation binding rather than a status write: a running attempt goes through the same outcome queue, a reserved attempt is fenced first so a queued start job cannot promote it and then written synchronously, a workflow-owned task is torn down through the stop path, and a plain task is written directly — the last three return { accepted: true, jobId: null }. That edge rejects cancellation_unavailable when the task is archived or already terminal, cancellation_invalid_transition when the managed write refuses the status, and direct_cancellation_unavailable when no attempt backs a direct-execution task. For done, blocked, or stopped, an attempt that is reserved rather than running, or bound to a different session, rejects with direct_attempt_not_running: the status itself is fine, but only cancelled fences an attempt that has not started so a queued start job cannot promote it. result may accompany only a transition to done, and blockReason only a transition to blocked, where human_input_requested is the single caller-settable value because every other block reason is stamped by the runtime that observed it. Supply expectedStatus to reject with invalid_transition unless the task is still in that state; it is applied at the status write, including transitions handed to a runtime. Moving a task with no workflow run and no agent session into in_progress claims one of the Space concurrency slots, so it rejects with space_at_task_capacity when the Space has none free; stop or finish a running task, or raise the Space limit, and retry. Moving a task to archived takes it off the active board and is terminal, and it rejects with archive_active_run while the task belongs to a workflow run that is still going, since archiving would strand the run — cancel the run first. An agent (MCP) caller asking for done from any status other than review or approved is routed to review instead, with result carried as the review reason: completion is a human checkpoint regardless of whether the task runs under a workflow or directly. Leaving approved for done runs the completion binding for MCP callers rather than a status write: only the task’s own worker session may complete it, only the routed post-approval session once one is routed, and the workflow’s completion gate applies, which for a coder-owned-merge workflow holds the task open until its pull request is merged. When result is omitted it falls back to the run’s artifact summary, then the existing result, then the reported summary, then “Task completed.”. That edge returns the updated task, or rejects task_completion_unavailable (with a detail message when the completion gate holds the task) and task_completion_denied; RPC callers write the status directly. Returns core task data, a durable outcome acknowledgement for a running direct attempt, null for absent tasks, { accepted: false, reason: "task_transition_denied" } when the calling MCP session is not active in the owning Space, or unsupported_status, direct_attempt_not_running, invalid_transition, result_requires_done, block_reason_requires_blocked, space_at_task_capacity, archive_active_run, or one of the review-submission, cancellation and completion reasons above when rejected.';
export function createSpaceTransitionTaskOperation(deps: Deps) {
  const transition = (superpipe({ deps })('transition-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveOwner, ['input', 'deps'], 'result:outcome')
    .pipe(admitCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(loadTask, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(requireExpectedStatus, ['outcome', 'input'], 'result:outcome')
    .pipe(routeAgentCompletionToReview, ['outcome', 'input', 'caller'], 'input')
    .pipe(decide, ['outcome', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(routeActiveDirectAttempt, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(requireFreeTaskSlot, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(writeStatus, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: In, caller: Caller) => Promise<Result>;
  return createTransitionTaskOperation(transition, {
    inputSchema: SpaceTransitionTaskInputSchema,
    description: SPACE_TRANSITION_TASK_DESCRIPTION,
  });
}
