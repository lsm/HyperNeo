import superpipe, { type PipelineAPI } from 'superpipe';
import {
  buildTaskDependencyGraph,
  hasTaskDependencyCycle,
  type TaskDependencyNode,
} from './dependency-graph.ts';

type DependencyRejection =
  | 'task_not_found'
  | 'self_dependency'
  | 'duplicate_dependency'
  | 'dependency_not_found'
  | 'dependency_cycle';
type Gate = { value: readonly string[] } | { reason: DependencyRejection };

export function requireDependencyTarget(
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): Gate {
  return tasks.some((task) => task.id === taskId)
    ? { value: dependsOn }
    : { reason: 'task_not_found' };
}

export function requireDistinctDependencies(taskId: string, dependsOn: readonly string[]): Gate {
  if (dependsOn.includes(taskId)) return { reason: 'self_dependency' };
  return new Set(dependsOn).size === dependsOn.length
    ? { value: dependsOn }
    : { reason: 'duplicate_dependency' };
}

export function requireExistingDependencies(
  tasks: readonly TaskDependencyNode[],
  dependsOn: readonly string[]
): Gate {
  const ids = new Set(tasks.map((task) => task.id));
  return dependsOn.every((id) => ids.has(id))
    ? { value: dependsOn }
    : { reason: 'dependency_not_found' };
}

export function requireAcyclicDependencies(
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): Gate {
  return hasTaskDependencyCycle(buildTaskDependencyGraph(tasks, taskId, dependsOn))
    ? { reason: 'dependency_cycle' }
    : { value: dependsOn };
}

function copyDependencies(dependsOn: readonly string[]): string[] {
  return [...dependsOn];
}

export const planTaskDependencies = (superpipe({})('plan-task-dependencies') as PipelineAPI)
  .input(['tasks', 'taskId', 'dependsOn'])
  .pipe(requireDependencyTarget, ['tasks', 'taskId', 'dependsOn'], 'result:dependencies')
  .pipe(requireDistinctDependencies, ['taskId', 'dependsOn'], 'result:dependencies')
  .pipe(requireExistingDependencies, ['tasks', 'dependsOn'], 'result:dependencies')
  .pipe(requireAcyclicDependencies, ['tasks', 'taskId', 'dependsOn'], 'result:dependencies')
  .pipe(copyDependencies, 'dependsOn', 'dependencies')
  .end('dependencies') as (
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
) => string[] | DependencyRejection;
