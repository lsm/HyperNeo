import { expect, mock, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createUpdateTaskOperation } from '../../../../src/lib/tasks/update-operation';

test.each(['rpc', 'mcp', 'internal'] as const)(
  'forwards trusted %s caller with normalized metadata',
  async (source) => {
    const edit = mock(async () => null);
    const registry = createOperationRegistry([createUpdateTaskOperation(edit)]);
    const caller = { source, sessionId: 'session-1' };
    expect(
      await invokeOperation(
        registry,
        'task.update',
        { taskId: 'task-1', title: ' Updated ' },
        caller
      )
    ).toEqual({ kind: 'completed', value: null });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith({ taskId: 'task-1', title: 'Updated' }, caller);
  }
);

test.each([
  { taskId: 'task-1', dependsOn: [] },
  { taskId: 'task-1', dependsOn: ['task-2'] },
  { taskId: 'task-1', title: ' Updated ', dependsOn: ['task-2'] },
])('accepts the replacement dependency list %j', async (input) => {
  const edit = mock(async () => null);
  const registry = createOperationRegistry([createUpdateTaskOperation(edit)]);
  const caller = { source: 'mcp', sessionId: 'session-1' } as const;
  expect(await invokeOperation(registry, 'task.update', input, caller)).toEqual({
    kind: 'completed',
    value: null,
  });
  expect(edit).toHaveBeenCalledWith(
    { ...input, ...(input.title ? { title: input.title.trim() } : {}) },
    caller
  );
});

test.each(['self_dependency', 'dependency_cycle', 'duplicate_dependency', 'dependency_not_found'])(
  'returns the dependency rejection %s to the caller',
  async (reason) => {
    const edit = mock(async () => reason as 'self_dependency');
    const registry = createOperationRegistry([createUpdateTaskOperation(edit)]);
    expect(
      await invokeOperation(
        registry,
        'task.update',
        { taskId: 'task-1', dependsOn: ['task-2'] },
        { source: 'mcp' }
      )
    ).toEqual({ kind: 'completed', value: reason });
  }
);

test.each([
  { taskId: 'task-1' },
  { taskId: 'task-1', title: ' ' },
  { taskId: 'task-1', title: 'Title', caller: { source: 'rpc' } },
  { taskId: 'task-1', status: 'done' },
  { taskId: 'task-1', dependsOn: [''] },
  { taskId: 'task-1', dependsOn: 'task-2' },
])('keeps invalid update input rejected before execution %j', async (input) => {
  const edit = mock(async () => null);
  const registry = createOperationRegistry([createUpdateTaskOperation(edit)]);
  expect(await invokeOperation(registry, 'task.update', input, { source: 'mcp' })).toMatchObject({
    kind: 'failed',
    code: 'invalid_input',
  });
  expect(edit).not.toHaveBeenCalled();
});
