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

test('unwraps runtime recovery without leaking workflow data into the task result', async () => {
  const task = { id: 'task-1', spaceId: 'space-1', status: 'open' } as SpaceTask;
  const recoverWorkflowBackedTask = mock(async () => ({
    task,
    run: { id: 'run-1' } as import('@hyperneo/shared').SpaceWorkflowRun,
  }));
  const executor = createWorkflowTaskRecoveryExecutor('space-1', { recoverWorkflowBackedTask });
  expect(await recoverTaskExecution(executor, 'task-1', 'open')).toBe(task);
  expect(recoverWorkflowBackedTask).toHaveBeenCalledWith('space-1', 'task-1', 'open');
});

test.each([
  { description: 'New instructions' },
  { description: undefined },
  { workflowNodeId: 'node-2', agentName: 'builder', description: 'Resume here' },
])('forwards bound workflow recovery options %j', async (options) => {
  const task = { id: 'task-1', spaceId: 'space-1', status: 'in_progress' } as SpaceTask;
  const recoverWorkflowBackedTask = mock(async () => ({
    task,
    run: { id: 'run-1' } as import('@hyperneo/shared').SpaceWorkflowRun,
  }));
  const executor = createWorkflowTaskRecoveryExecutor(
    'space-1',
    { recoverWorkflowBackedTask },
    options
  );
  expect(await recoverTaskExecution(executor, 'task-1', 'in_progress')).toBe(task);
  expect(recoverWorkflowBackedTask).toHaveBeenCalledWith(
    'space-1',
    'task-1',
    'in_progress',
    options
  );
});

test('retains the runtime method receiver and propagates its failure', async () => {
  const failure = new Error('Task task-1 is not backed by a workflow run');
  const runtime = {
    failure,
    async recoverWorkflowBackedTask(): Promise<SpaceTask> {
      throw this.failure;
    },
  };
  const executor = createWorkflowTaskRecoveryExecutor('space-1', runtime);
  await expect(recoverTaskExecution(executor, 'task-1', 'open')).rejects.toBe(failure);
});
