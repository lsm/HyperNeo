import { describe, expect, test } from 'bun:test';
import type { SpaceTask } from '@hyperneo/shared';
import { requireDependencyExecutionBlock } from '../../../../src/lib/space/tools/update-task-fields.ts';

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
});
