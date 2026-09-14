import type { Session, SpaceTask } from '@hyperneo/shared';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { Logger } from '../../logger.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { TaskWithSpaceFieldsSchema } from '../../operations/task-get.ts';
import { type SpaceTaskManager, StaleTaskGuardError } from '../managers/space-task-manager.ts';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager.ts';
import type { SpaceMcpSessionPolicyContext } from '../runtime/space-mcp-session-policy.ts';
import { admitSpaceTaskCaller, resolveSpaceTaskOwner } from './task-metadata.ts';

const log = new Logger('SetPreferredWorkflow');

export const SetPreferredWorkflowInputSchema = z
  .object({
    taskId: z.string().min(1),
    workflowId: z.string().min(1).nullable(),
  })
  .strict();
export type SetPreferredWorkflowInput = z.infer<typeof SetPreferredWorkflowInputSchema>;

export type SetPreferredWorkflowRejection =
  | 'workflow_locked'
  | 'workflow_not_found'
  | 'workflow_disabled';

type In = SetPreferredWorkflowInput;
type Result = TaskCore | SetPreferredWorkflowRejection | null;
type Gate<T> = { value: T } | { reason: Result };
type OwnedTask = { spaceId: string; task: SpaceTask };

export interface SetPreferredWorkflowDependencies extends SpaceMcpSessionPolicyContext {
  db: Database;
  getSession: (sessionId: string) => Session | null;
  getTaskManager: (spaceId: string) => Pick<SpaceTaskManager, 'getTask' | 'updateTask'>;
  getWorkflow: (workflowId: string) => ReturnType<SpaceWorkflowManager['getWorkflow']>;
  emitTaskUpdated: (spaceId: string, task: SpaceTask) => Promise<void>;
}
type Deps = SetPreferredWorkflowDependencies;

export function hasStarted(task: Pick<SpaceTask, 'workflowRunId' | 'startedAt'>): boolean {
  return !!task.workflowRunId || !!task.startedAt;
}

export function resolveOwner(input: In, deps: Deps): Gate<string> {
  const owner = resolveSpaceTaskOwner(deps.db, input.taskId);
  if (owner === null || owner.kind === 'standalone') return { reason: null };
  return { value: owner.spaceId };
}

export function admitCaller(spaceId: string, caller: OperationCaller, deps: Deps): Gate<string> {
  const admission = admitSpaceTaskCaller({ kind: 'space', spaceId }, caller, deps);
  return 'reason' in admission ? { reason: null } : { value: spaceId };
}

export async function loadTask(spaceId: string, input: In, deps: Deps): Promise<Gate<OwnedTask>> {
  const task = await deps.getTaskManager(spaceId).getTask(input.taskId);
  return task ? { value: { spaceId, task } } : { reason: null };
}

export function shortCircuitUnchanged(owned: OwnedTask, input: In): Gate<OwnedTask> {
  return (owned.task.preferredWorkflowId ?? null) === input.workflowId
    ? { reason: owned.task }
    : { value: owned };
}

export function requireUnstarted(owned: OwnedTask): Gate<OwnedTask> {
  return hasStarted(owned.task) ? { reason: 'workflow_locked' } : { value: owned };
}

export function requireSelectableWorkflow(
  owned: OwnedTask,
  input: In,
  deps: Deps
): Gate<OwnedTask> {
  if (input.workflowId === null) return { value: owned };
  const workflow = deps.getWorkflow(input.workflowId);
  if (!workflow || workflow.spaceId !== owned.spaceId) return { reason: 'workflow_not_found' };
  if (workflow.disabled) return { reason: 'workflow_disabled' };
  return { value: owned };
}

export async function writeSelection(owned: OwnedTask, input: In, deps: Deps): Promise<Result> {
  const { spaceId } = owned;
  try {
    const updated = await deps
      .getTaskManager(spaceId)
      .updateTask(
        input.taskId,
        { preferredWorkflowId: input.workflowId, workflowModelOverrides: null },
        { guardWrite: (current) => (hasStarted(current) ? 'task_started' : undefined) }
      );
    await deps
      .emitTaskUpdated(spaceId, updated)
      .catch((error: unknown) => log.warn('Failed to emit space.task.updated:', error));
    return updated;
  } catch (error) {
    if (error instanceof StaleTaskGuardError) return 'workflow_locked';
    throw error;
  }
}

const SET_PREFERRED_WORKFLOW_DESCRIPTION =
  'Choose which Space workflow a task will run when it next starts, or clear the selection with a null workflowId. Changing the selection also clears the task workflowModelOverrides, because per-node overrides are keyed to the workflow they were authored against and would otherwise silently re-attach wherever node and agent keys happen to overlap. The selection is locked once the task starts: a task with a workflowRunId or a startedAt rejects with workflow_locked, and the write is guarded on that condition so a start racing the write loses rather than landing after execution began. Re-sending the selection a task already carries succeeds without a write, so retries are safe. Returns the updated core task data, null for an absent, standalone, or out-of-scope task, workflow_not_found when the id names no workflow in the owning Space, workflow_disabled when it names a disabled one, and workflow_locked when the task has already started.';

export function createSetPreferredWorkflowOperation(deps: Deps) {
  const setPreferredWorkflow = (superpipe({ deps })('set-preferred-workflow') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveOwner, ['input', 'deps'], 'result:outcome')
    .pipe(admitCaller, ['outcome', 'caller', 'deps'], 'result:outcome')
    .pipe(loadTask, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(shortCircuitUnchanged, ['outcome', 'input'], 'result:outcome')
    .pipe(requireUnstarted, 'outcome', 'result:outcome')
    .pipe(requireSelectableWorkflow, ['outcome', 'input', 'deps'], 'result:outcome')
    .pipe(writeSelection, ['outcome', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: In, caller: OperationCaller) => Promise<Result>;

  return defineOperation({
    name: 'task.setPreferredWorkflow',
    description: SET_PREFERRED_WORKFLOW_DESCRIPTION,
    inputSchema: SetPreferredWorkflowInputSchema,
    resultSchema: z.union([
      TaskWithSpaceFieldsSchema.nullable(),
      z.enum(['workflow_locked', 'workflow_not_found', 'workflow_disabled']),
    ]),
    execute: (input, caller) => setPreferredWorkflow(input, caller),
  });
}
