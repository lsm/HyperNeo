import { describe, expect, mock, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import {
  finishDependencyExecutionBlock,
  requireDependencyExecutionBlock,
  updateTaskFields,
} from '../../../../src/lib/space/tools/update-task-fields.ts';

const task = {
  id: 'task',
  status: 'in_progress',
  workflowRunId: 'run',
} as SpaceTask;
const blocked = { ...task, status: 'blocked', blockReason: 'dependency_added' } as SpaceTask;

describe('dependency execution blocking', () => {
  test.each([
    [task, blocked, true],
    [null, blocked, false],
    [{ ...task, workflowRunId: null }, blocked, false],
    [{ ...task, status: 'open' }, blocked, false],
    [task, task, false],
    [task, { ...blocked, blockReason: 'dependency_failed' }, false],
  ] as const)('gates the actual persisted status change (%#)', (previous, updated, admitted) => {
    expect(
      requireDependencyExecutionBlock(previous as SpaceTask | null, updated as SpaceTask)
    ).toEqual(
      admitted ? { value: updated } : { reason: { task: updated, handledByRuntime: false } }
    );
  });

  test('awaits field mutation before cleanup and returns runtime result', async () => {
    const effects: string[] = [];
    const cleaned = { ...blocked, taskAgentSessionId: null };
    const result = await updateTaskFields(
      task,
      async () => {
        await Promise.resolve();
        effects.push('fields');
        return blocked;
      },
      async (taskId) => {
        expect(taskId).toBe(task.id);
        effects.push('cleanup');
        return cleaned;
      }
    );
    expect(effects).toEqual(['fields', 'cleanup']);
    expect(result).toEqual({ task: cleaned, handledByRuntime: true });
  });

  test('does not clean up ordinary metadata updates', async () => {
    const cleanup = mock(async () => blocked);
    expect(await updateTaskFields(task, async () => task, cleanup)).toEqual({
      task,
      handledByRuntime: false,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('propagates mutation rejection without execution effects', async () => {
    const cleanup = mock(async () => blocked);
    await expect(
      updateTaskFields(
        task,
        async () => {
          throw new Error('Invalid dependency');
        },
        cleanup
      )
    ).rejects.toThrow('Invalid dependency');
    expect(cleanup).not.toHaveBeenCalled();
  });

  test('rejects a missing runtime result', async () => {
    await expect(finishDependencyExecutionBlock(async () => null, blocked)).rejects.toThrow(
      'Failed to block workflow-backed task task'
    );
  });
});
