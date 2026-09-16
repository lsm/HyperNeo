import { describe, expect, mock, test } from 'bun:test';
import { z } from 'zod';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import {
  createDaemonOperationCatalog,
  type TaskOperationDependencies,
} from '../../../../src/lib/operations/catalog';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { defineOperation } from '../../../../src/lib/operations/registry';

const unused = () => {
  throw new Error('task dependency should not run in this test');
};

const tasks = {
  readTask: unused,
  createTask: unused,
  listTasks: unused,
  editTask: unused,
  transitionTask: unused,
  setDependencies: unused,
} as unknown as TaskOperationDependencies;

function familyOperation(execute = mock(async () => ({ ok: true }))) {
  return {
    execute,
    definition: defineOperation({
      name: 'family.example',
      description: 'A ported family operation.',
      inputSchema: z.object({}).default({}),
      resultSchema: z.object({ ok: z.boolean() }),
      policy: { safetyClass: 'read' },
      execute,
    }),
  };
}

describe('createDaemonOperationCatalog', () => {
  test('registers extra operations so they resolve by name and stay invocable', async () => {
    const { definition, execute } = familyOperation();
    const registry = createDaemonOperationCatalog({} as JobQueueRepository, tasks, [definition]);
    expect(registry.get('family.example')?.description).toBe('A ported family operation.');
    expect(registry.get('family.example')?.policy).toEqual({ safetyClass: 'read' });
    expect(await invokeOperation(registry, 'family.example', {}, { source: 'rpc' })).toEqual({
      kind: 'completed',
      value: { ok: true },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('lists extra operations ahead of the discovery operations', async () => {
    const { definition } = familyOperation();
    const registry = createDaemonOperationCatalog({} as JobQueueRepository, tasks, [definition]);
    const names = registry.entries.map((entry) => entry.name);
    expect(names).toContain('family.example');
    expect(names.indexOf('family.example')).toBeLessThan(names.indexOf('operations.list'));
    expect(names.at(-1)).toBe('operations.describe');
    expect(await invokeOperation(registry, 'operations.list', {}, { source: 'rpc' })).toEqual({
      kind: 'completed',
      value: registry.entries.map(({ name, description }) => ({ name, description })),
    });
  });

  test('omits nothing when no extra operations are supplied', () => {
    const baseline = createDaemonOperationCatalog({} as JobQueueRepository, tasks);
    const { definition } = familyOperation();
    const extended = createDaemonOperationCatalog({} as JobQueueRepository, tasks, [definition]);
    expect(baseline.get('family.example')).toBeUndefined();
    expect(extended.entries).toHaveLength(baseline.entries.length + 1);
  });
});
