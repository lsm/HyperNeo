import { describe, expect, mock, test } from 'bun:test';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { z } from 'zod';
import { describeOperationDefinition } from '../../../../src/lib/operations/discovery';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import {
  createCreateTaskOperation,
  StandaloneCreateTaskInputSchema,
} from '../../../../src/lib/operations/task-create';
import {
  createTransitionTaskOperation,
  StandaloneTransitionTaskInputSchema,
} from '../../../../src/lib/operations/task-transition';

const caller = { source: 'internal' as const, sessionId: 'session-1' };

const task: TaskCore = {
  id: 'task-id',
  title: 'A task',
  description: 'Core data',
  status: 'open',
  priority: 'normal',
  labels: [],
  dependsOn: [],
  result: null,
  createdAt: 10,
  startedAt: null,
  completedAt: null,
  archivedAt: null,
  updatedAt: 10,
};

describe('task.create schema options', () => {
  test('defaults to the standalone schema and description', () => {
    const registry = createOperationRegistry([createCreateTaskOperation(async () => task)]);
    const described = describeOperationDefinition(registry.get('task.create')!);
    expect(described.inputSchema).toEqual(
      z.toJSONSchema(StandaloneCreateTaskInputSchema, { io: 'input' })
    );
    expect(described.description).toBe(
      'Create an independent task in this daemon. Creates a work record without starting agent execution or attaching it to a Space.'
    );
  });

  test('a custom schema and description govern validation and discovery', async () => {
    const CustomInputSchema = z.object({ title: z.string().min(1), spaceId: z.string() }).strict();
    const createTask = mock(async (input: unknown) => ({ ...task, ...(input as object) }));
    const registry = createOperationRegistry([
      createCreateTaskOperation(createTask, {
        inputSchema: CustomInputSchema,
        description: 'Create a Space-bound task',
      }),
    ]);
    const described = describeOperationDefinition(registry.get('task.create')!);
    expect(described.inputSchema).toEqual(z.toJSONSchema(CustomInputSchema, { io: 'input' }));
    expect(described.description).toBe('Create a Space-bound task');

    expect(
      await invokeOperation(registry, 'task.create', { title: 'Title' }, caller)
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(createTask).not.toHaveBeenCalled();

    const input = { title: 'Title', spaceId: 'space-1' };
    expect(await invokeOperation(registry, 'task.create', input, caller)).toMatchObject({
      kind: 'completed',
    });
    expect(createTask).toHaveBeenCalledWith(input, 'session-1');
  });
});

describe('task.transition schema options', () => {
  test('defaults to the standalone schema and description', () => {
    const registry = createOperationRegistry([createTransitionTaskOperation(async () => task)]);
    const described = describeOperationDefinition(registry.get('task.transition')!);
    expect(described.inputSchema).toEqual(
      z.toJSONSchema(StandaloneTransitionTaskInputSchema, { io: 'input' })
    );
    expect(described.description).toBe(
      'Change a standalone task lifecycle state. in_progress tracks manual work without starting an agent. Supply result only for done. Returns updated core data, null for absent or Space-owned tasks, or unsupported_status, invalid_transition, or result_requires_done when rejected. Archived tasks cannot reopen.'
    );
  });

  test('a custom schema and description govern validation and discovery', async () => {
    const CustomStatusSchema = z
      .object({ taskId: z.string().min(1), status: z.enum(['queued', 'active']) })
      .strict();
    const transitionTask = mock(async () => task);
    const registry = createOperationRegistry([
      createTransitionTaskOperation(transitionTask, {
        inputSchema: CustomStatusSchema,
        description: 'Transition a Space-bound task',
      }),
    ]);
    const described = describeOperationDefinition(registry.get('task.transition')!);
    expect(described.inputSchema).toEqual(z.toJSONSchema(CustomStatusSchema, { io: 'input' }));
    expect(described.description).toBe('Transition a Space-bound task');

    const legacyInput = { taskId: 'task-1', status: 'in_progress' };
    expect(await invokeOperation(registry, 'task.transition', legacyInput, caller)).toMatchObject({
      kind: 'failed',
      code: 'invalid_input',
    });
    expect(transitionTask).not.toHaveBeenCalled();

    const input = { taskId: 'task-1', status: 'queued' };
    expect(await invokeOperation(registry, 'task.transition', input, caller)).toMatchObject({
      kind: 'completed',
    });
    expect(transitionTask).toHaveBeenCalledWith(input, caller);
  });
});
