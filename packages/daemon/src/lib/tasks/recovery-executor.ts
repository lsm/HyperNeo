import type { SpaceTask } from '@hyperneo/shared';
import type { TaskRecoveryExecutor } from './recover-task-execution.ts';
import type { TaskTransitionExpectation } from './task-manager.ts';

export type WorkflowTaskRecoveryOptions = {
  workflowNodeId?: string;
  agentName?: string;
  description?: string;
  manualHandoff?: boolean;
} & TaskTransitionExpectation;

export interface WorkflowTaskRecoverer {
  recoverWorkflowBackedTask(
    spaceId: string,
    taskId: string,
    targetStatus: 'open' | 'in_progress',
    options?: WorkflowTaskRecoveryOptions
  ): Promise<SpaceTask | { task: SpaceTask }>;
}

export function createWorkflowTaskRecoveryExecutor(
  spaceId: string,
  runtime: WorkflowTaskRecoverer,
  options?: WorkflowTaskRecoveryOptions
): TaskRecoveryExecutor<SpaceTask> {
  return {
    recover: async (taskId, targetStatus) => {
      const recovered = await runtime.recoverWorkflowBackedTask(
        spaceId,
        taskId,
        targetStatus,
        ...(options === undefined ? [] : [options])
      );
      return 'task' in recovered ? recovered.task : recovered;
    },
  };
}
