import { z } from 'zod';
import type {
  setStandaloneTaskDependencies,
  SetTaskDependenciesInput,
} from '../../storage/tasks/set-task-dependencies.ts';
import { defineOperation, type OperationCaller } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

type DependencyResult = ReturnType<typeof setStandaloneTaskDependencies>;

export function createSetTaskDependenciesOperation(
  setDependencies: (
    input: SetTaskDependenciesInput,
    caller: OperationCaller
  ) => DependencyResult | Promise<DependencyResult>
) {
  return defineOperation({
    name: 'task.dependencies.set',
    description:
      'Replace dependencies using task-owner rules. IDs must share the target owner; an empty dependsOn array clears the list. Returns updated core data or null for unavailable targets. Standalone validation returns rejection codes; Space validation returns operation errors and preserves duplicate IDs. Space updates may block execution for unmet dependencies. MCP Space updates require a session in the owning Space.',
    inputSchema: z
      .object({ taskId: z.string().min(1), dependsOn: z.array(z.string().min(1)) })
      .strict(),
    resultSchema: z.union([
      TaskCoreSchema.nullable(),
      z.enum([
        'task_not_found',
        'self_dependency',
        'duplicate_dependency',
        'dependency_not_found',
        'dependency_cycle',
      ]),
    ]),
    execute: async (input, caller) => setDependencies(input, caller),
  });
}
