import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import {
  actionAsOperation,
  actionsAsOperations,
} from '../../../../src/lib/space/actions/action-operations.ts';
import { createActionRegistry, defineAction } from '../../../../src/lib/space/actions/registry.ts';

function registryOf(...names: string[]) {
  return registryOfClass('read', ...names);
}

function registryOfClass(safetyClass: 'read' | 'mutate', ...names: string[]) {
  return createActionRegistry(
    names.map((name) =>
      defineAction({
        name,
        family: 'tasks',
        safetyClass,
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

  test('adapted snake_case names compose into an operation registry', () => {
    const operations = actionsAsOperations(registryOf('archive_task', 'list_actions'));
    const registry = createOperationRegistry(operations);
    expect(registry.get('archive_task')).toBeDefined();
    expect(registry.get('list_actions')).toBeDefined();
  });

  test('adapted actions merge with the base catalog without collision', () => {
    const base = createOperationRegistry([]);
    const merged = createOperationRegistry([
      ...base.entries,
      ...actionsAsOperations(registryOf('get_task_detail')),
    ]);
    expect(merged.get('get_task_detail')).toBeDefined();
  });

  test('mutating actions are not exposed until the pre-invocation gates exist', () => {
    const operations = actionsAsOperations(registryOfClass('mutate', 'archive_task'));
    expect(operations).toEqual([]);
  });
});
