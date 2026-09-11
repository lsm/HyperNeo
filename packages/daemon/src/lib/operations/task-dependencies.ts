import { z } from 'zod';
import type {
  setStandaloneTaskDependencies,
  SetTaskDependenciesInput,
} from '../../storage/tasks/set-task-dependencies.ts';
import { defineOperation } from './registry.ts';
import { TaskCoreSchema } from './task-get.ts';

type DependencyResult = ReturnType<typeof setStandaloneTaskDependencies>;

export function createSetTaskDependenciesOperation(
  setDependencies: (input: SetTaskDependenciesInput) => DependencyResult | Promise<DependencyResult>
) {
  return defineOperation({
    name: 'task.dependencies.set',
    description:
      'Replace a standalone task dependency list with other standalone task IDs. An empty dependsOn array clears dependencies. Returns updated core data, null for absent or Space-owned targets, or a rejection code for missing tasks, self-dependencies, duplicates or cycles. Does not schedule execution.',
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
    execute: async (input) => setDependencies(input),
  });
}
