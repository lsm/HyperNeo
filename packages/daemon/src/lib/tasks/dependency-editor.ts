import type { TaskMutationDenial } from './mutation-denial.ts';
import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SetTaskDependenciesInput } from '../../storage/tasks/set-task-dependencies.ts';
import type { planTaskDependencies } from './dependency-plan.ts';
import type { OperationCaller } from '../operations/registry.ts';

export type TaskDependencyOwner = { kind: 'standalone' } | { kind: 'space'; spaceId: string };
export type TaskDependencyResult =
  | TaskCore
  | TaskMutationDenial
  | null
  | Extract<ReturnType<typeof planTaskDependencies>, string>;
type Awaitable<T> = T | Promise<T>;

export interface TaskDependencyEditorDependencies {
  resolveOwner: (taskId: string) => Awaitable<TaskDependencyOwner | null>;
  admit: (
    owner: TaskDependencyOwner,
    caller: OperationCaller
  ) => Awaitable<void | TaskMutationDenial>;
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
  return result === null || typeof result === 'string' || 'accepted' in result
    ? { reason: result }
    : { value: result };
}

export async function resolveTaskDependencyOwner(
  resolveOwner: TaskDependencyEditorDependencies['resolveOwner'],
  input: SetTaskDependenciesInput
) {
  return requireTaskDependencyOwner(await resolveOwner(input.taskId));
}

export async function replaceOwnedTaskDependencies(
  replaceStandalone: TaskDependencyEditorDependencies['replaceStandalone'],
  replaceSpace: TaskDependencyEditorDependencies['replaceSpace'],
  owner: TaskDependencyOwner,
  input: SetTaskDependenciesInput
) {
  return requireReplacedTaskDependencies(
    await (owner.kind === 'standalone'
      ? replaceStandalone(input)
      : replaceSpace(owner.spaceId, input))
  );
}

async function admitTaskDependencyEdit(
  admit: TaskDependencyEditorDependencies['admit'],
  owner: TaskDependencyOwner,
  caller: OperationCaller
): Promise<{ value: TaskDependencyOwner } | { reason: TaskMutationDenial }> {
  const denial = await admit(owner, caller);
  return denial ? { reason: denial } : { value: owner };
}

export function createTaskDependencyEditor(dependencies: TaskDependencyEditorDependencies) {
  return (superpipe({ ...dependencies })('replace-task-dependencies') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(selectTaskDependencies, 'input', 'replacement')
    .pipe(resolveTaskDependencyOwner, ['resolveOwner', 'replacement'], 'result:task')
    .pipe((owner: TaskDependencyOwner) => owner, 'task', 'owner')
    .pipe(admitTaskDependencyEdit, ['admit', 'task', 'caller'], 'result:task')
    .pipe(
      replaceOwnedTaskDependencies,
      ['replaceStandalone', 'replaceSpace', 'task', 'replacement'],
      'result:task'
    )
    .pipe('?afterReplace', ['owner', 'task'])
    .endAsync('task') as (
    input: SetTaskDependenciesInput,
    caller: OperationCaller
  ) => Promise<TaskDependencyResult>;
}
