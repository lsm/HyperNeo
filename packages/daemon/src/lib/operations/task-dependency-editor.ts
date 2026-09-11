import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SetTaskDependenciesInput } from '../../storage/tasks/set-task-dependencies.ts';
import type { planTaskDependencies } from '../tasks/dependency-plan.ts';
import type { OperationCaller } from './registry.ts';

export type TaskDependencyOwner = { kind: 'standalone' } | { kind: 'space'; spaceId: string };
export type TaskDependencyResult =
  | TaskCore
  | null
  | Extract<ReturnType<typeof planTaskDependencies>, string>;
type Awaitable<T> = T | Promise<T>;

export interface TaskDependencyEditorDependencies {
  resolveOwner: (taskId: string) => Awaitable<TaskDependencyOwner | null>;
  admit: (owner: TaskDependencyOwner, caller: OperationCaller) => Awaitable<void>;
  replaceStandalone: (input: SetTaskDependenciesInput) => Awaitable<TaskDependencyResult>;
  replaceSpace: (
    spaceId: string,
    input: SetTaskDependenciesInput
  ) => Awaitable<TaskDependencyResult>;
  afterReplace?: (owner: TaskDependencyOwner, task: TaskCore) => Awaitable<void>;
}

export function selectTaskDependencies(input: SetTaskDependenciesInput): SetTaskDependenciesInput {
  return { taskId: input.taskId, dependsOn: [...input.dependsOn] };
}

export function requireTaskDependencyOwner(owner: TaskDependencyOwner | null) {
  return owner === null ? { reason: null } : { value: owner };
}

export function requireReplacedTaskDependencies(result: TaskDependencyResult) {
  return result === null || typeof result === 'string' ? { reason: result } : { value: result };
}

export function resolveTaskDependencyOwner(
  resolveOwner: TaskDependencyEditorDependencies['resolveOwner'],
  input: SetTaskDependenciesInput
) {
  return resolveOwner(input.taskId);
}

export function replaceOwnedTaskDependencies(
  replaceStandalone: TaskDependencyEditorDependencies['replaceStandalone'],
  replaceSpace: TaskDependencyEditorDependencies['replaceSpace'],
  owner: TaskDependencyOwner,
  input: SetTaskDependenciesInput
) {
  return owner.kind === 'standalone'
    ? replaceStandalone(input)
    : replaceSpace(owner.spaceId, input);
}

export function createTaskDependencyEditor(dependencies: TaskDependencyEditorDependencies) {
  return (superpipe({ ...dependencies })('replace-task-dependencies') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(selectTaskDependencies, 'input', 'replacement')
    .pipe(resolveTaskDependencyOwner, ['resolveOwner', 'replacement'], 'owner')
    .pipe(requireTaskDependencyOwner, 'owner', 'result:task')
    .pipe('admit', ['task', 'caller'])
    .pipe(
      replaceOwnedTaskDependencies,
      ['replaceStandalone', 'replaceSpace', 'task', 'replacement'],
      'replaced'
    )
    .pipe(requireReplacedTaskDependencies, 'replaced', 'result:task')
    .pipe('?afterReplace', ['owner', 'task'])
    .endAsync('task') as (
    input: SetTaskDependenciesInput,
    caller: OperationCaller
  ) => Promise<TaskDependencyResult>;
}
