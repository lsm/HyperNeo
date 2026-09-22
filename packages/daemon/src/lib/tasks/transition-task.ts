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
  | 'invalid_transition'
  | 'result_requires_done'
  | 'block_reason_requires_blocked'
  | 'space_at_task_capacity'
  | 'archive_active_run';
type Result = TaskCore | Rejection | TaskMutationDenial | DirectOutcomeAcknowledgement | null;
export interface SpaceTransitionTaskDependencies extends SpaceTransitionAdmissionDependencies {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'>;
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
}
type Deps = SpaceTransitionTaskDependencies;
type DecidedTask = OwnedTask & {
  approvalSource: 'human' | undefined;
  allowActiveRun: boolean;
};
type RuntimeExecutor = 'park_stopped' | 'recover_transition' | 'stop_for_status';

async function runRuntimeExecutor(
  executor: RuntimeExecutor,
  { spaceId, task }: OwnedTask,
  input: In,
  deps: Deps,
  approvalSource: 'human' | undefined
): Promise<Result> {
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
    workflowRunId: task.workflowRunId ?? null,
    runActive,
    callerSource: caller.source,
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
  'Space-scoped callers change the lifecycle state of a task in their Space; review and approved are entered only through the submit-for-review and approval operations, and rate_limited/usage_limited are runtime-owned. A running direct-execution attempt moving to done, blocked, cancelled, or stopped is shut down through the durable outcome queue before the task status commits; that route returns { accepted, jobId } instead of task data. Reserved attempts remain fenced and must use task.cancel. result may accompany only a transition to done, and blockReason only a transition to blocked, where human_input_requested is the single caller-settable value because every other block reason is stamped by the runtime that observed it. Supply expectedStatus to reject with invalid_transition unless the task is still in that state; it is applied at the status write, including transitions handed to a runtime. Moving a task with no workflow run and no agent session into in_progress claims one of the Space concurrency slots, so it rejects with space_at_task_capacity when the Space has none free; stop or finish a running task, or raise the Space limit, and retry. Moving a task to archived takes it off the active board and is terminal, and it rejects with archive_active_run while the task belongs to a workflow run that is still going, since archiving would strand the run — cancel the run first. Returns core task data, a durable outcome acknowledgement for a running direct attempt, null for absent tasks, { accepted: false, reason: "task_transition_denied" } when the calling MCP session is not active in the owning Space, or unsupported_status, invalid_transition, result_requires_done, block_reason_requires_blocked, space_at_task_capacity, or archive_active_run when rejected.';
export function createSpaceTransitionTaskOperation(deps: Deps) {
  const transition = (superpipe({ deps })('transition-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveOwner, ['input', 'deps'], 'result:outcome')
    .pipe(admitCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(loadTask, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(requireExpectedStatus, ['outcome', 'input'], 'result:outcome')
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
