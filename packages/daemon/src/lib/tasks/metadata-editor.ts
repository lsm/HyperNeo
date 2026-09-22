import type { TaskMutationDenial } from './mutation-denial.ts';
import type { TaskCore, TaskPriority } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import type { planTaskDependencies } from './dependency-plan.ts';

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
  editStandalone: (
    input: TaskMetadataInput
  ) => Awaitable<TaskCore | TaskDependencyRejection | null>;
  editSpace: (
    spaceId: string,
    input: TaskMetadataInput
  ) => Awaitable<{ task: TaskCore; handledByRuntime: boolean } | null>;
  afterEdit?: (
    owner: TaskMetadataOwner,
    task: TaskCore,
    input: TaskMetadataInput,
    handledByRuntime: boolean
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

type WrittenTask = { task: TaskCore; handledByRuntime: boolean };

export function takeHandledByRuntime(written: WrittenTask): boolean {
  return written.handledByRuntime;
}

export function takeEditedTask(written: WrittenTask): TaskCore {
  return written.task;
}

export async function persistTaskMetadata(
  editStandalone: TaskMetadataDependencies['editStandalone'],
  editSpace: TaskMetadataDependencies['editSpace'],
  owner: TaskMetadataOwner,
  input: TaskMetadataInput
): Promise<
  | { value: { task: TaskCore; handledByRuntime: boolean } }
  | { reason: TaskDependencyRejection | null }
> {
  if (owner.kind === 'standalone') {
    const edited = await editStandalone(input);
    return edited === null || typeof edited === 'string'
      ? { reason: edited }
      : { value: { task: edited, handledByRuntime: false } };
  }
  const edited = await editSpace(owner.spaceId, input);
  return edited === null ? { reason: null } : { value: edited };
}

export function createTaskMetadataEditor(dependencies: TaskMetadataDependencies) {
  return (superpipe({ ...dependencies })('edit-task-metadata') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(selectTaskMetadata, 'input', 'metadata')
    .pipe(resolveTaskMetadataOwner, ['resolveOwner', 'metadata'], 'result:editedTask')
    .pipe(admitTaskMetadataEdit, ['admit', 'editedTask', 'caller'], 'result:editedTask')
    .pipe((owner: TaskMetadataOwner) => owner, 'editedTask', 'owner')
    .pipe(
      persistTaskMetadata,
      ['editStandalone', 'editSpace', 'owner', 'metadata'],
      'result:editedTask'
    )
    .pipe(takeHandledByRuntime, 'editedTask', 'handledByRuntime')
    .pipe(takeEditedTask, 'editedTask', 'editedTask')
    .pipe('?afterEdit', ['owner', 'editedTask', 'metadata', 'handledByRuntime'])
    .endAsync('editedTask') as (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => Promise<TaskCore | TaskMutationDenial | TaskDependencyRejection | null>;
}
