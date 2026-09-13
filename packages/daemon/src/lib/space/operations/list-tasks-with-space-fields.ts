import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ListTasksInput, TaskListPage } from '../../../storage/tasks/list-tasks.ts';

export interface SpaceTaskBatchReader {
  getTasksByIds: (ids: string[]) => SpaceTask[];
}

export function spaceTaskBatchReader(repo: unknown): SpaceTaskBatchReader | undefined {
  const candidate = repo as { getTasksByIds?: unknown } | undefined;
  return typeof candidate?.getTasksByIds === 'function'
    ? (candidate as SpaceTaskBatchReader)
    : undefined;
}

function readCorePage(
  listCores: (input: ListTasksInput) => TaskListPage,
  input: ListTasksInput
): TaskListPage {
  return listCores(input);
}

function readSpaceRows(page: TaskListPage, reader?: SpaceTaskBatchReader): SpaceTask[] {
  if (!reader || page.tasks.length === 0) return [];
  return reader.getTasksByIds(page.tasks.map((task) => task.id));
}

function mergeSpaceRows(page: TaskListPage, rows: SpaceTask[]): TaskListPage {
  if (rows.length === 0) return page;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return { ...page, tasks: page.tasks.map((task) => byId.get(task.id) ?? task) };
}

export const listTasksWithSpaceFields = (
  superpipe({})('list-tasks-with-space-fields') as PipelineAPI
)
  .input(['listCores', 'input', 'reader'])
  .pipe(readCorePage, ['listCores', 'input'], 'page')
  .pipe(readSpaceRows, ['page', 'reader'], 'rows')
  .pipe(mergeSpaceRows, ['page', 'rows'], 'merged')
  .end('merged') as (
  listCores: (input: ListTasksInput) => TaskListPage,
  input: ListTasksInput,
  reader?: SpaceTaskBatchReader
) => TaskListPage;
