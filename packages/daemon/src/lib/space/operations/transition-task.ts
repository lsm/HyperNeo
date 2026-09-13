import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import { Logger } from '../../logger.ts';
import type { OperationCaller } from '../../operations/registry.ts';
import { createTransitionTaskOperation } from '../../operations/task-transition.ts';
import { type SpaceTaskManager, StaleTaskGuardError } from '../managers/space-task-manager.ts';
import { decideSpaceTaskTransition } from './transition-decision.ts';
import {
  admitCaller,
  type Gate,
  loadTask,
  type OwnedTask,
  rejectActiveDirectAttempt,
  resolveOwner,
  type SpaceTransitionAdmissionDependencies,
  type SpaceTransitionTaskInput,
  SpaceTransitionTaskInputSchema,
} from './transition-task-admission.ts';

const log = new Logger('SpaceTransitionTask');
type In = SpaceTransitionTaskInput;
type Caller = OperationCaller;
type Rejection = 'unsupported_status' | 'invalid_transition' | 'result_requires_done';
type Result = TaskCore | Rejection | null;
export interface SpaceTransitionTaskDependencies extends SpaceTransitionAdmissionDependencies {
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'setTaskStatus'>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
  isWorkflowRunActive: (workflowRunId: string) => boolean;
  recoverTransition?: (
    spaceId: string,
    taskId: string,
    status: 'open' | 'in_progress'
  ) => Promise<TaskCore | string>;
  stopForStatus?: (
    spaceId: string,
    taskId: string,
    params: UpdateSpaceTaskParams
  ) => Promise<SpaceTask | null>;
  parkStopped?: (spaceId: string, taskId: string) => Promise<SpaceTask>;
}
type Deps = SpaceTransitionTaskDependencies;
type DecidedTask = OwnedTask & { approvalSource: 'human' | undefined };
type RuntimeExecutor = 'park_stopped' | 'recover_transition' | 'stop_for_status';

async function runRuntimeExecutor(
  executor: RuntimeExecutor,
  { spaceId, task }: OwnedTask,
  input: In,
  deps: Deps
): Promise<Result> {
  if (executor === 'park_stopped') {
    if (!deps.parkStopped) throw new Error(`Space runtime executor unavailable: ${executor}`);
    return deps.parkStopped(spaceId, task.id);
  }
  if (executor === 'recover_transition') {
    if (!deps.recoverTransition) throw new Error(`Space runtime executor unavailable: ${executor}`);
    const recovered = await deps.recoverTransition(
      spaceId,
      task.id,
      input.status as 'open' | 'in_progress'
    );
    return typeof recovered === 'string' ? 'invalid_transition' : recovered;
  }
  if (!deps.stopForStatus) throw new Error(`Space runtime executor unavailable: ${executor}`);
  const stopped = await deps.stopForStatus(spaceId, task.id, { status: input.status });
  return stopped ?? 'invalid_transition';
}

export async function decide(
  owned: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Promise<Gate<DecidedTask, Result>> {
  const { task } = owned;
  const decision = decideSpaceTaskTransition({
    taskId: input.taskId,
    currentStatus: task.status,
    requestedStatus: input.status,
    hasResult: input.result !== undefined,
    workflowRunId: task.workflowRunId ?? null,
    runActive: task.workflowRunId ? deps.isWorkflowRunActive(task.workflowRunId) : false,
    callerSource: caller.source,
  });
  if (decision.action === 'reject') return { reason: decision.result };
  if (decision.action === 'runtime') {
    return { reason: await runRuntimeExecutor(decision.executor, owned, input, deps) };
  }
  return { value: { ...owned, approvalSource: decision.approvalSource } };
}
async function emitUpdated(spaceId: string, task: SpaceTask, deps: Deps): Promise<void> {
  await deps
    .emitTaskUpdated(spaceId, task)
    .catch((error: unknown) => log.warn('Failed to emit space.task.updated:', error));
}
function guardActiveExecution(deps: Deps): (current: SpaceTask) => string | undefined {
  return (current) => {
    if (new DirectTaskExecutionRepository(deps.db).getActive(current.id)) {
      return 'active_direct_attempt';
    }
    if (current.workflowRunId && deps.isWorkflowRunActive(current.workflowRunId)) {
      return 'active_workflow_run';
    }
    return undefined;
  };
}
export async function writeStatus(decided: DecidedTask, input: In, deps: Deps): Promise<Result> {
  const { spaceId, task, approvalSource } = decided;
  try {
    const updated = await deps.getTaskManager(spaceId).setTaskStatus(task.id, input.status, {
      result: input.result,
      approvalSource,
      expectedStatus: task.status,
      expectedWorkflowRunId: task.workflowRunId ?? null,
      guardWrite: guardActiveExecution(deps),
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
  'Space-scoped callers change the lifecycle state of a task in their Space; review and approved are entered only through the submit-for-review and approval operations, and rate_limited/usage_limited are runtime-owned. Tasks with an active direct-execution attempt are managed by the durable start/cancel/complete operations, and result may accompany only a transition to done. Returns core task data, null for absent or unavailable tasks, or unsupported_status, invalid_transition, or result_requires_done when rejected.';
export function createSpaceTransitionTaskOperation(deps: Deps) {
  const transition = (superpipe({ deps })('transition-space-task') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveOwner, ['input', 'deps'], 'result:outcome')
    .pipe(admitCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(loadTask, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(rejectActiveDirectAttempt, ['outcome', 'deps'], 'result:outcome')
    .pipe(decide, ['outcome', 'input', 'caller', 'deps'], 'result:outcome')
    .pipe(writeStatus, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: In, caller: Caller) => Promise<Result>;
  return createTransitionTaskOperation(transition, {
    inputSchema: SpaceTransitionTaskInputSchema,
    description: SPACE_TRANSITION_TASK_DESCRIPTION,
  });
}
