import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createGetTaskOperation } from '../../../../src/lib/operations/task-get';

const task: TaskCore = {
  id: 'task-id',
  title: 'A task',
  description: 'Core data',
  status: 'open',
  priority: 'normal',
  labels: ['work'],
  dependsOn: ['another-task'],
  result: null,
  createdAt: 10,
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  updatedAt: 10,
};

function fixture(value: TaskCore | null = task) {
  const read = mock(async (_taskId: string) => value);
  return { read, registry: createOperationRegistry([createGetTaskOperation(read)]) };
}

describe('task.get operation', () => {
  test.each(['rpc', 'mcp', 'internal'] as const)(
    'reads core data for %s callers',
    async (source) => {
      const { read, registry } = fixture();
      expect(await invokeOperation(registry, 'task.get', { taskId: task.id }, { source })).toEqual({
        kind: 'completed',
        value: task,
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(task.id);
    }
  );

  test('returns null for an absent task', async () => {
    const { registry } = fixture(null);
    expect(
      await invokeOperation(registry, 'task.get', { taskId: 'absent' }, { source: 'rpc' })
    ).toEqual({
      kind: 'completed',
      value: null,
    });
  });

  test.each([{}, { taskId: '' }, { taskId: 1 }])(
    'rejects invalid task IDs before reading: %j',
    async (input) => {
      const { read, registry } = fixture();
      expect(await invokeOperation(registry, 'task.get', input, { source: 'mcp' })).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
      expect(read).not.toHaveBeenCalled();
    }
  );

  test('projects Space task data without exposing ownership or execution fields', async () => {
    const spaceTask = { ...task, spaceId: 'space', taskNumber: 3, taskAgentSessionId: 'session' };
    const registry = createOperationRegistry([createGetTaskOperation(() => spaceTask)]);
    expect(
      await invokeOperation(registry, 'task.get', { taskId: task.id }, { source: 'rpc' })
    ).toEqual({
      kind: 'completed',
      value: task,
    });
    expect(spaceTask.spaceId).toBe('space');
  });
});
