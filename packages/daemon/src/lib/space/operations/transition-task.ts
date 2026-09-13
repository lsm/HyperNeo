import type { SpaceTask } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
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
}
type Deps = SpaceTransitionTaskDependencies;
type DecidedTask = OwnedTask & { approvalSource: 'human' | undefined };

export function decide(
  owned: OwnedTask,
  input: In,
  caller: Caller,
  deps: Deps
): Gate<DecidedTask, Rejection> {
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
    throw new Error(`Space runtime executor unavailable: ${decision.executor}`);
  }
  return { value: { ...owned, approvalSource: decision.approvalSource } };
}
async function emitUpdated(spaceId: string, task: SpaceTask, deps: Deps): Promise<void> {
  await deps
    .emitTaskUpdated(spaceId, task)
    .catch((error: unknown) => log.warn('Failed to emit space.task.updated:', error));
}
export async function writeStatus(decided: DecidedTask, input: In, deps: Deps): Promise<Result> {
  const { spaceId, task, approvalSource } = decided;
  try {
    const updated = await deps.getTaskManager(spaceId).setTaskStatus(task.id, input.status, {
      result: input.result,
      approvalSource,
      expectedStatus: task.status,
      expectedWorkflowRunId: task.workflowRunId ?? null,
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
