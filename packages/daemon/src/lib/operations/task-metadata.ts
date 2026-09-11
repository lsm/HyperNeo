import type { TaskCore, TaskPriority } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from './registry.ts';

export interface TaskMetadataInput {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
}

export type TaskMetadataOwner = { kind: 'standalone' } | { kind: 'space'; spaceId: string };

type Awaitable<T> = T | Promise<T>;

export interface TaskMetadataDependencies {
  resolveOwner: (taskId: string) => Awaitable<TaskMetadataOwner | null>;
  admit: (owner: TaskMetadataOwner, caller: OperationCaller) => Awaitable<void>;
  editStandalone: (input: TaskMetadataInput) => Awaitable<TaskCore | null>;
  editSpace: (spaceId: string, input: TaskMetadataInput) => Awaitable<TaskCore | null>;
}

export function selectTaskMetadata(input: TaskMetadataInput): TaskMetadataInput {
  return {
    taskId: input.taskId,
    ...(Object.hasOwn(input, 'title') ? { title: input.title } : {}),
    ...(Object.hasOwn(input, 'description') ? { description: input.description } : {}),
    ...(Object.hasOwn(input, 'priority') ? { priority: input.priority } : {}),
    ...(Object.hasOwn(input, 'labels') ? { labels: input.labels } : {}),
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
): Promise<void> {
  await admit(owner, caller);
}

export async function persistTaskMetadata(
  editStandalone: TaskMetadataDependencies['editStandalone'],
  editSpace: TaskMetadataDependencies['editSpace'],
  owner: TaskMetadataOwner,
  input: TaskMetadataInput
): Promise<{ value: TaskCore } | { reason: null }> {
  const task = await (owner.kind === 'standalone'
    ? editStandalone(input)
    : editSpace(owner.spaceId, input));
  return task === null ? { reason: null } : { value: task };
}

export function createTaskMetadataEditor(dependencies: TaskMetadataDependencies) {
  return (superpipe({ ...dependencies })('edit-task-metadata') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(selectTaskMetadata, 'input', 'metadata')
    .pipe(resolveTaskMetadataOwner, ['resolveOwner', 'metadata'], 'result:editedTask')
    .pipe(admitTaskMetadataEdit, ['admit', 'editedTask', 'caller'])
    .pipe(
      persistTaskMetadata,
      ['editStandalone', 'editSpace', 'editedTask', 'metadata'],
      'result:editedTask'
    )
    .endAsync('editedTask') as (
    input: TaskMetadataInput,
    caller: OperationCaller
  ) => Promise<TaskCore | null>;
}
