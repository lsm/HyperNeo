import { expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { createWorkflowTaskParkingExecutor } from '../../../../src/lib/space/runtime/task-parking-executor.ts';
import { parkTaskExecution } from '../../../../src/lib/tasks/park-task-execution.ts';

test.each([
  null,
  {
    id: 'task-1',
    spaceId: 'space-1',
    workflowRunId: 'run-1',
    status: 'stopped',
  } as SpaceTask,
])('preserves the runtime parking result %j', async (task) => {
  const parkStoppedWorkflowTask = mock(async () => task);
  const executor = createWorkflowTaskParkingExecutor('space-1', { parkStoppedWorkflowTask });
  expect(await parkTaskExecution(executor, 'task-1')).toBe(task);
  expect(parkStoppedWorkflowTask).toHaveBeenCalledTimes(1);
  expect(parkStoppedWorkflowTask).toHaveBeenCalledWith('space-1', 'task-1');
});

test('preserves the runtime receiver and its original failure', async () => {
  const failure = new Error('Invalid status transition from draft to stopped');
  const runtime = {
    failure,
    async parkStoppedWorkflowTask(): Promise<SpaceTask> {
      throw this.failure;
    },
  };
  const executor = createWorkflowTaskParkingExecutor('space-1', runtime);
  await expect(parkTaskExecution(executor, 'task-1')).rejects.toBe(failure);
});
