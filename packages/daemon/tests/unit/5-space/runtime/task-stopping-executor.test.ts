import { expect, mock, test } from 'bun:test';
import type { SpaceTask, UpdateSpaceTaskParams } from '@hyperneo/shared';
import { createWorkflowTaskStoppingExecutor } from '../../../../src/lib/space/runtime/task-stopping-executor.ts';
import { stopTaskExecution } from '../../../../src/lib/tasks/stop-task-execution.ts';

const task = { id: 'task-1', spaceId: 'space-1', status: 'open' } as SpaceTask;

test.each(['open', 'cancelled', 'blocked'] as const)(
  'binds teardown target %s and update options',
  async (status) => {
    const options: Omit<UpdateSpaceTaskParams, 'status'> = {
      title: 'Updated',
      description: 'Instructions',
      priority: 'high',
      dependsOn: ['task-2'],
      workspacePath: '/repo',
      result: null,
      approvalReason: undefined,
      cancelReason: 'Cancelled by caller',
    };
    const stopWorkflowBackedTaskForStatus = mock(async () => task);
    const executor = createWorkflowTaskStoppingExecutor(
      'space-1',
      { stopWorkflowBackedTaskForStatus },
      options
    );
    expect(await stopTaskExecution(executor, task.id, status)).toBe(task);
    expect(stopWorkflowBackedTaskForStatus).toHaveBeenCalledTimes(1);
    expect(stopWorkflowBackedTaskForStatus).toHaveBeenCalledWith('space-1', task.id, {
      ...options,
      status,
    });
  }
);

test('preserves null for the caller to apply its existing fallback', async () => {
  const stopWorkflowBackedTaskForStatus = mock(async () => null);
  const executor = createWorkflowTaskStoppingExecutor('space-1', {
    stopWorkflowBackedTaskForStatus,
  });
  expect(await stopTaskExecution(executor, task.id, 'open')).toBeNull();
  expect(stopWorkflowBackedTaskForStatus).toHaveBeenCalledWith('space-1', task.id, {
    status: 'open',
  });
});

test('preserves the runtime receiver and failure', async () => {
  const failure = new Error('Failed to stop workflow-backed task task-1');
  const runtime = {
    failure,
    async stopWorkflowBackedTaskForStatus(): Promise<SpaceTask> {
      throw this.failure;
    },
  };
  const executor = createWorkflowTaskStoppingExecutor('space-1', runtime);
  await expect(stopTaskExecution(executor, task.id, 'open')).rejects.toBe(failure);
});
