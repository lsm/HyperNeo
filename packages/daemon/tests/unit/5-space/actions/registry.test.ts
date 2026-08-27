import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createActionRegistry,
  defineAction,
  type ActionDefinition,
} from '../../../../src/lib/space/actions/registry.ts';

const taskActionSchema = z.object({ taskId: z.string() });

function makeReadAction(name = 'list_tasks'): ActionDefinition {
  return defineAction({
    name,
    family: 'tasks',
    safetyClass: 'read',
    description: 'Lists tasks in the space',
    paramsDoc: 'No parameters',
    paramsSchema: z.object({}),
    handler: async () => [{ id: 't1' }],
  });
}

describe('defineAction', () => {
  test('erases the handler to unknown params while preserving authored behavior', async () => {
    const received: unknown[] = [];
    const definition = defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Updates a task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      handler: async (params) => {
        received.push(params);
        return { ok: true, taskId: params.taskId };
      },
    });
    const result = await definition.handler({ taskId: 't-1' });
    expect(result).toEqual({ ok: true, taskId: 't-1' });
    expect(received).toEqual([{ taskId: 't-1' }]);
  });

  test('erases an async autonomy resolver the same way', async () => {
    const definition = defineAction({
      name: 'approve_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Approves a task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      autonomyRequirement: async (params) => (params.taskId === 'blocked' ? 5 : 4),
      handler: async () => null,
    });
    const resolve = definition.autonomyRequirement;
    expect(typeof resolve).toBe('function');
    if (typeof resolve === 'function') {
      expect(await resolve({ taskId: 'blocked' })).toBe(5);
      expect(await resolve({ taskId: 't-1' })).toBe(4);
    }
  });

  test('passes a numeric autonomy requirement through unchanged', () => {
    const definition = defineAction({
      name: 'archive_session',
      family: 'sessions',
      safetyClass: 'mutate',
      description: 'Archives a session',
      paramsDoc: 'sessionId: string',
      paramsSchema: z.object({ sessionId: z.string() }),
      autonomyRequirement: 4,
      handler: async () => null,
    });
    expect(definition.autonomyRequirement).toBe(4);
  });

  test('preserves authored fields and the schema object reference verbatim', () => {
    const definition = defineAction({
      name: 'get_task',
      family: 'tasks',
      safetyClass: 'read',
      description: 'Gets one task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      handler: async () => null,
    });
    expect(definition.name).toBe('get_task');
    expect(definition.family).toBe('tasks');
    expect(definition.safetyClass).toBe('read');
    expect(definition.description).toBe('Gets one task');
    expect(definition.paramsDoc).toBe('taskId: string');
    expect(definition.paramsSchema).toBe(taskActionSchema);
  });
});

describe('createActionRegistry validation', () => {
  test('accepts a fully classified registry and preserves entry order', () => {
    const first = makeReadAction('list_tasks');
    const second = defineAction({
      name: 'update_task',
      family: 'tasks',
      safetyClass: 'mutate',
      description: 'Updates a task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      autonomyRequirement: 4,
      handler: async () => null,
    });
    const registry = createActionRegistry([first, second]);
    expect(registry.entries.map((action) => action.name)).toEqual(['list_tasks', 'update_task']);
    expect(registry.get('update_task')?.safetyClass).toBe('mutate');
  });

  test('rejects unclassified entries — omission is presumed mutating and denied by default', () => {
    const unclassified = defineAction({
      name: 'update_task',
      family: 'tasks',
      description: 'Updates a task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      handler: async () => null,
    });
    expect(() => createActionRegistry([makeReadAction(), unclassified])).toThrow(
      /actions\[1\] \("update_task"\): unclassified safetyClass \(undefined\).*presumed mutating/
    );
  });

  test('rejects unknown safety class values from untyped callers under the same rule', () => {
    const forged = { ...makeReadAction(), safetyClass: 'write' } as unknown as ActionDefinition;
    expect(() => createActionRegistry([forged])).toThrow(
      /actions\[0\] \("list_tasks"\): unclassified safetyClass \(write\)/
    );
  });

  test('rejects duplicate action names', () => {
    expect(() => createActionRegistry([makeReadAction(), makeReadAction()])).toThrow(
      /duplicate action name "list_tasks" \(first defined at actions\[0\]\)/
    );
  });

  test('rejects names that are not non-empty strings', () => {
    const unnamed = { ...makeReadAction(), name: '' } as ActionDefinition;
    expect(() => createActionRegistry([unnamed])).toThrow(
      /actions\[0\]: action name must be a non-empty string/
    );
  });

  test('aggregates every violation into one error instead of failing on the first', () => {
    const unclassified = defineAction({
      name: 'update_task',
      family: 'tasks',
      description: 'Updates a task',
      paramsDoc: 'taskId: string',
      paramsSchema: taskActionSchema,
      handler: async () => null,
    });
    const duplicate = makeReadAction();
    const unnamed = { ...makeReadAction(''), name: '' } as ActionDefinition;
    expect(() =>
      createActionRegistry([makeReadAction(), unclassified, duplicate, unnamed])
    ).toThrow(
      /rejected 3 action\(s\).*unclassified safetyClass.*duplicate action name.*non-empty string/
    );
  });

  test('an empty registry is valid', () => {
    const registry = createActionRegistry([]);
    expect(registry.entries).toEqual([]);
    expect(registry.get('list_tasks')).toBeUndefined();
  });
});

describe('ActionRegistry lookups', () => {
  test('resolves by exact name only and returns undefined for unknown names', () => {
    const registry = createActionRegistry([makeReadAction()]);
    expect(registry.get('list_tasks')?.name).toBe('list_tasks');
    expect(registry.get('LIST_TASKS')).toBeUndefined();
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.get('')).toBeUndefined();
  });

  test('registered handlers and autonomy resolvers stay callable through the registry', async () => {
    const registry = createActionRegistry([
      defineAction({
        name: 'approve_task',
        family: 'tasks',
        safetyClass: 'human_only',
        description: 'Approves a task',
        paramsDoc: 'taskId: string',
        paramsSchema: taskActionSchema,
        autonomyRequirement: async (params) => (params.taskId === 'review-gated' ? 5 : 3),
        handler: async (params) => ({ approved: params.taskId }),
      }),
    ]);
    const action = registry.get('approve_task');
    expect(action?.safetyClass).toBe('human_only');
    if (!action) return;
    expect(await action.handler({ taskId: 't-1' })).toEqual({ approved: 't-1' });
    const resolve = action.autonomyRequirement;
    expect(typeof resolve).toBe('function');
    if (typeof resolve === 'function') {
      expect(await resolve({ taskId: 'review-gated' })).toBe(5);
    }
  });
});
