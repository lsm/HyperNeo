import { expect, mock, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { createUpdateTaskOperation } from '../../../../src/lib/operations/task-update';

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
  { taskId: 'task-1' },
  { taskId: 'task-1', title: ' ' },
  { taskId: 'task-1', title: 'Title', caller: { source: 'rpc' } },
  { taskId: 'task-1', status: 'done' },
])('keeps invalid update input rejected before execution %j', async (input) => {
  const edit = mock(async () => null);
  const registry = createOperationRegistry([createUpdateTaskOperation(edit)]);
  expect(await invokeOperation(registry, 'task.update', input, { source: 'mcp' })).toMatchObject({
    kind: 'failed',
    code: 'invalid_input',
  });
  expect(edit).not.toHaveBeenCalled();
});
