import {
  buildDependencyGraph,
  type DependencyNode,
  hasDependencyCycle,
} from './dependency-graph.ts';

export type DependencyRejection =
  | 'task_not_found'
  | 'self_dependency'
  | 'duplicate_dependency'
  | 'dependency_not_found'
  | 'dependency_ended'
  | 'dependency_cycle';
export type DependencyGate = { value: readonly string[] } | { reason: DependencyRejection };

export function requireDependencyTarget(
  tasks: readonly DependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): DependencyGate {
  return tasks.some((task) => task.id === taskId)
    ? { value: dependsOn }
    : { reason: 'task_not_found' };
}

export function requireDistinctDependencies(
  taskId: string,
  dependsOn: readonly string[]
): DependencyGate {
  if (dependsOn.includes(taskId)) return { reason: 'self_dependency' };
  return new Set(dependsOn).size === dependsOn.length
    ? { value: dependsOn }
    : { reason: 'duplicate_dependency' };
}

export function requireExistingDependencies(
  tasks: readonly DependencyNode[],
  dependsOn: readonly string[]
): DependencyGate {
  const ids = new Set(tasks.map((task) => task.id));
  return dependsOn.every((id) => ids.has(id))
    ? { value: dependsOn }
    : { reason: 'dependency_not_found' };
}

export function requireAcyclicDependencies(
  tasks: readonly DependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): DependencyGate {
  return hasDependencyCycle(buildDependencyGraph(tasks, taskId, dependsOn))
    ? { reason: 'dependency_cycle' }
    : { value: dependsOn };
}
