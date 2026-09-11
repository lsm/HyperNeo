import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

interface FieldUpdateResult {
  task: SpaceTask;
  handledByRuntime: boolean;
}

export function requireDependencyExecutionBlock(previous: SpaceTask | null, updated: SpaceTask) {
  return previous?.status === 'in_progress' &&
    previous.workflowRunId &&
    updated.status === 'blocked' &&
    updated.blockReason === 'dependency_added'
    ? { value: updated }
    : { reason: { task: updated, handledByRuntime: false } };
}

export async function finishDependencyExecutionBlock(
  blockExecution: (taskId: string) => Promise<SpaceTask | null>,
  updated: SpaceTask
): Promise<FieldUpdateResult> {
  const task = await blockExecution(updated.id);
  if (!task) throw new Error(`Failed to block workflow-backed task ${updated.id}`);
  return { task, handledByRuntime: true };
}

export const updateTaskFields = (superpipe({})('update-task-fields') as PipelineAPI)
  .input(['previous', 'updateFields', 'blockExecution'])
  .pipe((updateFields: () => Promise<SpaceTask>) => updateFields(), 'updateFields', 'updated')
  .pipe(requireDependencyExecutionBlock, ['previous', 'updated'], 'result:outcome')
  .pipe(finishDependencyExecutionBlock, ['blockExecution', 'updated'], 'outcome')
  .endAsync('outcome') as (
  previous: SpaceTask | null,
  updateFields: () => Promise<SpaceTask>,
  blockExecution: (taskId: string) => Promise<SpaceTask | null>
) => Promise<FieldUpdateResult>;
