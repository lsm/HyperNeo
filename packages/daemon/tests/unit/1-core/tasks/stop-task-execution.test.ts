import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  executeTaskStopping,
  requireStoppingExecutor,
  requireStopTarget,
  stopTaskExecution,
} from '../../../../src/lib/tasks/stop-task-execution.ts';

const task: TaskCore = {
  id: 'task-1',
  title: 'Task',
  description: '',
  status: 'open',
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

describe('task execution stopping', () => {
  test('requires an explicit executor', () => {
    const executor = { stopForStatus: async () => task };
    expect(requireStoppingExecutor(executor)).toEqual({ value: executor });
    expect(requireStoppingExecutor(undefined)).toEqual({ reason: 'execution_unavailable' });
  });

  test.each(['open', 'cancelled', 'blocked'])('admits teardown target %s', (status) => {
    expect(requireStopTarget(status)).toEqual({ value: status });
  });

  test.each([
    'in_progress',
    'stopped',
    'done',
    'archived',
    'review',
    'approved',
    'draft',
    'rate_limited',
    'usage_limited',
    '',
  ])('rejects non-teardown target %s', (status) => {
    expect(requireStopTarget(status)).toEqual({ reason: 'invalid_stop_status' });
  });

  test.each([task, null])('wraps result %j in an explicit result arm', async (result) => {
    const stopForStatus = mock(async () => result);
    expect(await executeTaskStopping({ stopForStatus }, task.id, 'open')).toEqual(
      result === null ? { reason: null } : { value: result }
    );
    expect(stopForStatus).toHaveBeenCalledWith(task.id, 'open');
  });

  test.each(['open', 'cancelled', 'blocked'] as const)('awaits stopping to %s', async (status) => {
    let finish!: (value: TaskCore) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const stopForStatus = mock(
      () =>
        new Promise<TaskCore>((resolve) => {
          finish = resolve;
          signalStarted();
        })
    );
    const pending = stopTaskExecution({ stopForStatus }, task.id, status);
    await started;
    expect(stopForStatus).toHaveBeenCalledTimes(1);
    expect(stopForStatus).toHaveBeenCalledWith(task.id, status);
    const updated = { ...task, status };
    finish(updated);
    expect(await pending).toBe(updated);
  });

  test('rejects unsupported targets without stopping execution', async () => {
    const stopForStatus = mock(async () => task);
    expect(await stopTaskExecution({ stopForStatus }, task.id, 'done')).toBe('invalid_stop_status');
    expect(stopForStatus).not.toHaveBeenCalled();
  });

  test('missing execution takes precedence over invalid target', async () => {
    expect(await stopTaskExecution(undefined, task.id, 'done')).toBe('execution_unavailable');
  });

  test('preserves null and original failures', async () => {
    expect(
      await stopTaskExecution({ stopForStatus: async () => null }, task.id, 'open')
    ).toBeNull();
    const failure = new Error('Invalid transition');
    await expect(
      stopTaskExecution(
        {
          stopForStatus: async () => {
            throw failure;
          },
        },
        task.id,
        'open'
      )
    ).rejects.toBe(failure);
  });
});
