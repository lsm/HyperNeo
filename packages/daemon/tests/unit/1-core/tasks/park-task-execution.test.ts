import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  executeTaskParking,
  parkTaskExecution,
  requireParkingExecutor,
} from '../../../../src/lib/tasks/park-task-execution.ts';

const task: TaskCore = {
  id: 'task-1',
  title: 'Task',
  description: '',
  status: 'stopped',
  priority: 'normal',
  labels: [],
  dependsOn: [],
  result: null,
  createdAt: 1,
  startedAt: 1,
  completedAt: null,
  archivedAt: null,
  updatedAt: 2,
};

describe('task execution parking', () => {
  test.each([task, null])('wraps executor result %j in an explicit result arm', async (result) => {
    const park = mock(async () => result);
    expect(await executeTaskParking({ park }, task.id)).toEqual(
      result === null ? { reason: null } : { value: result }
    );
    expect(park).toHaveBeenCalledWith(task.id);
  });

  test('requires an explicit parking executor', () => {
    const executor = { park: async () => task };
    expect(requireParkingExecutor(executor)).toEqual({ value: executor });
    expect(requireParkingExecutor(undefined)).toEqual({ reason: 'execution_unavailable' });
  });

  test('reports unavailable execution without mutating a task', async () => {
    expect(await parkTaskExecution(undefined, task.id)).toBe('execution_unavailable');
  });

  test('awaits parking completion before returning the executor result', async () => {
    let finish!: (value: TaskCore) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const park = mock(
      () =>
        new Promise<TaskCore>((resolve) => {
          finish = resolve;
          signalStarted();
        })
    );
    const pending = parkTaskExecution({ park }, task.id);
    await started;
    expect(park).toHaveBeenCalledTimes(1);
    expect(park).toHaveBeenCalledWith(task.id);
    finish(task);
    expect(await pending).toBe(task);
  });

  test('preserves missing-task results', async () => {
    const park = mock(async () => null);
    expect(await parkTaskExecution({ park }, 'missing')).toBeNull();
    expect(park).toHaveBeenCalledWith('missing');
  });

  test('propagates parking failures', async () => {
    const failure = new Error('Invalid status transition');
    const park = mock(async () => {
      throw failure;
    });
    await expect(parkTaskExecution({ park }, task.id)).rejects.toBe(failure);
  });
});
