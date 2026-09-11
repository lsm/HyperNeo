import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import {
  recoverTaskExecution,
  requireRecoveryExecutor,
  requireRecoveryTarget,
} from '../../../../src/lib/tasks/recover-task-execution.ts';

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
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  updatedAt: 2,
};

describe('task execution recovery', () => {
  test('requires an executor without creating one implicitly', () => {
    const executor = { recover: async () => task };
    expect(requireRecoveryExecutor(executor)).toEqual({ value: executor });
    expect(requireRecoveryExecutor(undefined)).toEqual({ reason: 'execution_unavailable' });
  });

  test.each(['open', 'in_progress'])('admits recovery target %s', (status) => {
    expect(requireRecoveryTarget(status)).toEqual({ value: status });
  });

  test.each(['draft', 'blocked', 'done', 'cancelled', 'archived', 'review', 'approved', ''])(
    'rejects non-recovery target %s',
    (status) => {
      expect(requireRecoveryTarget(status)).toEqual({ reason: 'invalid_recovery_status' });
    }
  );

  test.each(['open', 'in_progress'] as const)('awaits execution recovery to %s', async (status) => {
    let finish!: (value: TaskCore) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const recover = mock(
      () =>
        new Promise<TaskCore>((resolve) => {
          finish = resolve;
          signalStarted();
        })
    );
    const pending = recoverTaskExecution({ recover }, task.id, status);
    await started;
    expect(recover).toHaveBeenCalledWith(task.id, status);
    const recovered = { ...task, status };
    finish(recovered);
    expect(await pending).toBe(recovered);
  });

  test('rejects unsupported targets before calling the executor', async () => {
    const recover = mock(async () => task);
    expect(await recoverTaskExecution({ recover }, task.id, 'done')).toBe(
      'invalid_recovery_status'
    );
    expect(recover).not.toHaveBeenCalled();
  });

  test('missing execution takes precedence over invalid target', async () => {
    expect(await recoverTaskExecution(undefined, task.id, 'done')).toBe('execution_unavailable');
  });

  test('preserves execution failures without reporting success', async () => {
    const failure = new Error('execution superseded');
    const recover = mock(async () => {
      throw failure;
    });
    await expect(recoverTaskExecution({ recover }, task.id, 'open')).rejects.toBe(failure);
  });
});
