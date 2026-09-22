import type { TaskMutationDenial } from './mutation-denial.ts';
import type { TaskCore, TaskPriority } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import type { planTaskDependencies } from './dependency-plan.ts';
import type { SetTaskDependenciesInput } from '../../storage/tasks/set-task-dependencies.ts';

export type TaskDependencyRejection = Extract<ReturnType<typeof planTaskDependencies>, string>;

export interface TaskMetadataInput {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  dependsOn?: string[];
}

export type TaskMetadataOwner = { kind: 'standalone' } | { kind: 'space'; spaceId: string };

type Awaitable<T> = T | Promise<T>;

export interface TaskMetadataDependencies {
  resolveOwner: (taskId: string) => Awaitable<TaskMetadataOwner | null>;
  admit: (
    owner: TaskMetadataOwner,
    caller: OperationCaller
  ) => Awaitable<void | TaskMutationDenial>;
  replaceDependencies: (
    owner: TaskMetadataOwner,
    input: SetTaskDependenciesInput
  ) => Awaitable<TaskCore | TaskDependencyRejection | null>;
  editStandalone: (input: TaskMetadataInput) => Awaitable<TaskCore | null>;
  editSpace: (spaceId: string, input: TaskMetadataInput) => Awaitable<TaskCore | null>;
  afterEdit?: (
    owner: TaskMetadataOwner,
    task: TaskCore,
    input: TaskMetadataInput
  ) => Awaitable<void>;
}

export function selectTaskMetadata(input: TaskMetadataInput): TaskMetadataInput {
  return {
    taskId: input.taskId,
    ...(Object.hasOwn(input, 'title') ? { title: input.title } : {}),
    ...(Object.hasOwn(input, 'description') ? { description: input.description } : {}),
    ...(Object.hasOwn(input, 'priority') ? { priority: input.priority } : {}),
    ...(Object.hasOwn(input, 'labels') ? { labels: input.labels } : {}),
    ...(Object.hasOwn(input, 'dependsOn') ? { dependsOn: input.dependsOn } : {}),
  };
}

export function writesTaskMetadata(input: TaskMetadataInput): boolean {
  return (
    input.dependsOn === undefined ||
    [input.title, input.description, input.priority, input.labels].some(
      (value) => value !== undefined
    )
  );
}

export async function resolveTaskMetadataOwner(
  resolveOwner: TaskMetadataDependencies['resolveOwner'],
  input: TaskMetadataInput
): Promise<{ value: TaskMetadataOwner } | { reason: null }> {
  const owner = await resolveOwner(input.taskId);
  return owner === null ? { reason: null } : { value: owner };
}

export async function admitTaskMetadataEdit(
  admit: TaskMetadataDependencies['admit'],
  owner: TaskMetadataOwner,
  caller: OperationCaller
): Promise<{ value: TaskMetadataOwner } | { reason: TaskMutationDenial }> {
  const denial = await admit(owner, caller);
  return denial ? { reason: denial } : { value: owner };
}

export async function replaceTaskMetadataDependencies(
  replaceDependencies: TaskMetadataDependencies['replaceDependencies'],
  owner: TaskMetadataOwner,
  input: TaskMetadataInput
): Promise<{ value: TaskCore | null } | { reason: TaskDependencyRejection | null }> {
  if (input.dependsOn === undefined) return { value: null };
  const replaced = await replaceDependencies(owner, {
    taskId: input.taskId,
    dependsOn: input.dependsOn,
  });
  return replaced === null || typeof replaced === 'string'
    ? { reason: replaced }
    : { value: replaced };
}

export async function persistTaskMetadata(
  editStandalone: TaskMetadataDependencies['editStandalone'],
  editSpace: TaskMetadataDependencies['editSpace'],
  owner: TaskMetadataOwner,
  input: TaskMetadataInput,
  replaced?: TaskCore | null
): Promise<{ value: TaskCore } | { reason: null }> {
  const { dependsOn: _dependsOn, ...fields } = input;
  const task = writesTaskMetadata(input)
    ? await (owner.kind === 'standalone'
        ? editStandalone(fields)
        : editSpace(owner.spaceId, fields))
    : (replaced ?? null);
  return task === null ? { reason: null } : { value: task };
}

export function createTaskMetadataEditor(dependencies: TaskMetadataDependencies) {
  return (superpipe({ ...dependencies })('edit-task-metadata') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(selectTaskMetadata, 'input', 'metadata')
    .pipe(resolveTaskMetadataOwner, ['resolveOwner', 'metadata'], 'result:editedTask')
    .pipe(admitTaskMetadataEdit, ['admit', 'editedTask', 'caller'], 'result:editedTask')
    .pipe((owner: TaskMetadataOwner) => owner, 'editedTask', 'owner')
    .pipe(
      replaceTaskMetadataDependencies,
      ['replaceDependencies', 'owner', 'metadata'],
      'result:editedTask'
    )
    .pipe(
      persistTaskMetadata,
      ['editStandalone', 'editSpace', 'owner', 'metadata', 'editedTask'],
      'result:editedTask'
    )
    .pipe('?afterEdit', ['owner', 'editedTask', 'metadata'])
    .endAsync('editedTask') as (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => Promise<TaskCore | TaskMutationDenial | TaskDependencyRejection | null>;
}
