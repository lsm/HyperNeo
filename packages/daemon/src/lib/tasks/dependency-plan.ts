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
  | 'dependency_ended'
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

const ENDED_DEPENDENCY_STATUSES = new Set(['cancelled', 'archived']);

export function requireLiveDependencies(
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
): Gate {
  const existing = tasks.find((task) => task.id === taskId)?.dependsOn ?? [];
  const ended = new Set(
    tasks
      .filter((task) => task.status && ENDED_DEPENDENCY_STATUSES.has(task.status))
      .map((task) => task.id)
  );
  return dependsOn.some((id) => ended.has(id) && !existing.includes(id))
    ? { reason: 'dependency_ended' }
    : { value: dependsOn };
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
  .pipe(requireLiveDependencies, ['tasks', 'taskId', 'dependsOn'], 'result:dependencies')
  .pipe(requireAcyclicDependencies, ['tasks', 'taskId', 'dependsOn'], 'result:dependencies')
  .pipe(copyDependencies, 'dependsOn', 'dependencies')
  .end('dependencies') as (
  tasks: readonly TaskDependencyNode[],
  taskId: string,
  dependsOn: readonly string[]
) => string[] | DependencyRejection;

const NEW_TASK_ID = '\u0000new-task';

export function planNewTaskDependencies(
  tasks: readonly TaskDependencyNode[],
  dependsOn: readonly string[]
): string[] | DependencyRejection {
  return planTaskDependencies([...tasks, { id: NEW_TASK_ID }], NEW_TASK_ID, dependsOn);
}

export function dependencyRejectionMessage(
  reason: DependencyRejection,
  tasks: readonly TaskDependencyNode[],
  dependsOn: readonly string[],
  taskId?: string
): string {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const existing = (taskId ? byId.get(taskId)?.dependsOn : undefined) ?? [];
  if (reason === 'self_dependency') return 'A task cannot depend on itself';
  if (reason === 'duplicate_dependency') return 'A dependency is listed more than once';
  if (reason === 'dependency_not_found')
    return `Dependency task not found in space: ${dependsOn.find((id) => !byId.has(id))}`;
  if (reason === 'dependency_ended') {
    const ended = dependsOn
      .filter((id) => !existing.includes(id))
      .map((id) => byId.get(id))
      .find((task) => task?.status && ENDED_DEPENDENCY_STATUSES.has(task.status));
    return `Dependency task ${ended?.id} is ${ended?.status} and will never finish`;
  }
  if (reason === 'dependency_cycle')
    return 'Adding these dependencies would create a circular dependency';
  return `Task not found: ${taskId}`;
}
