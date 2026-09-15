import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  actionAsOperation,
  actionsAsOperations,
} from '../../../../src/lib/space/actions/action-operations.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';

function registryOf(...names: string[]) {
  return createActionRegistry(
    names.map((name) =>
      defineAction({
        name,
        family: 'tasks',
        safetyClass: 'mutate',
        description: `Do ${name}.`,
        paramsDoc: 'task_id',
        paramsSchema: z.object({ task_id: z.string() }).strict(),
        handler: async (params) => ({ ran: name, params }),
      })
    )
  );
}

describe('actions as operations', () => {
  test('every registry entry becomes an operation under its own name', () => {
    const operations = actionsAsOperations(registryOf('archive_task', 'cancel_task'));
    expect(operations.map((operation) => operation.name)).toEqual(['archive_task', 'cancel_task']);
  });

  test('the action handler is what the operation executes', async () => {
    const [operation] = actionsAsOperations(registryOf('archive_task'));
    const result = await operation.execute({ task_id: 't1' }, { source: 'mcp', sessionId: 's1' });
    expect(result).toEqual({ ran: 'archive_task', params: { task_id: 't1' } });
  });

  test('the action params schema becomes the operation input schema', () => {
    const [operation] = actionsAsOperations(registryOf('archive_task'));
    expect(operation.inputSchema.safeParse({ task_id: 't1' }).success).toBe(true);
    expect(operation.inputSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  test('the description carries the params doc so the catalog stays self-describing', () => {
    const [operation] = actionsAsOperations(registryOf('archive_task'));
    expect(operation.description).toContain('Do archive_task.');
    expect(operation.description).toContain('task_id');
  });

  test('results pass through unvalidated so handler shapes survive', () => {
    const registry = registryOf('archive_task');
    const operation = actionAsOperation(registry.entries[0]);
    expect(operation.resultSchema.safeParse({ anything: true }).success).toBe(true);
    expect(operation.resultSchema.safeParse('a string').success).toBe(true);
  });

  test('an empty registry yields no operations', () => {
    expect(actionsAsOperations(createActionRegistry([]))).toEqual([]);
  });
});
