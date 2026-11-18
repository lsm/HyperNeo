import { describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createCreateTaskOperation } from '../../../../src/lib/tasks/create-operation';
import { createGetTaskOperation } from '../../../../src/lib/tasks/get-operation';
import { createListTasksOperation } from '../../../../src/lib/tasks/list-operation';
import { createTransitionTaskOperation } from '../../../../src/lib/tasks/transition-operation';
import { createUpdateTaskOperation } from '../../../../src/lib/tasks/update-operation';

const caller: OperationCaller = { source: 'rpc', principal: 'local' };
const fail = (): never => {
  throw new Error('store unavailable');
};

describe('task operations', () => {
  const cases = [
    [createCreateTaskOperation(fail), { title: 'task' }],
    [createGetTaskOperation(fail), { taskId: 'task' }],
    [createGetTaskOperation(fail, fail), { taskId: 'task' }],
    [createGetTaskOperation(fail, fail), { spaceId: 'space', taskNumber: 1 }],
    [createListTasksOperation(fail), {}],
    [createTransitionTaskOperation(fail), { taskId: 'task', status: 'in_progress' }],
    [createUpdateTaskOperation(fail), { taskId: 'task', title: 'updated' }],
  ] as const;

  for (const [operation, input] of cases) {
    test(`${operation.name} reaches its store through a pipeline`, async () => {
      const failure = await Promise.resolve()
        .then(() => operation.execute(input as never, caller))
        .then(
          () => null,
          (error: Error) => error
        );
      expect(failure?.message).toBe('store unavailable');
      expect(failure?.stack).toContain('superpipe');
    });
  }
});
