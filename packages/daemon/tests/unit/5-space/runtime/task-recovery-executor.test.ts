import { expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { createWorkflowTaskRecoveryExecutor } from '../../../../src/lib/space/runtime/task-recovery-executor.ts';
import { recoverTaskExecution } from '../../../../src/lib/tasks/recover-task-execution.ts';

test.each(['open', 'in_progress'] as const)(
  'binds workflow recovery to its space and preserves the task for %s',
  async (status) => {
    const task = {
      id: 'task-1',
      spaceId: 'space-1',
      workflowRunId: 'run-1',
      status,
    } as SpaceTask;
    const recoverWorkflowBackedTask = mock(async () => task);
    const executor = createWorkflowTaskRecoveryExecutor('space-1', { recoverWorkflowBackedTask });
    expect(await recoverTaskExecution(executor, 'task-1', status)).toBe(task);
    expect(recoverWorkflowBackedTask).toHaveBeenCalledTimes(1);
    expect(recoverWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', status);
  }
);
