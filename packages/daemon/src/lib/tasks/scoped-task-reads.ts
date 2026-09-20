import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { ListTasksInput, TaskListPage } from '../../storage/tasks/list-tasks.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { OperationCaller } from '../operations/registry.ts';
import type { SpaceMcpSessionPolicyContext } from '../space/runtime/space-mcp-session-policy.ts';
import {
  admitSpaceTaskCaller,
  resolveSpaceTaskOwner,
  type SpaceTaskMetadataDependencies,
} from './metadata.ts';

export type TaskReadAdmission = Pick<SpaceTaskMetadataDependencies, 'getSession'> &
  SpaceMcpSessionPolicyContext;

type TaskReader = (taskId: string) => TaskCore | null;
type TaskNumberReader = (spaceId: string, taskNumber: number) => TaskCore | null;
type TaskPageReader = (input: ListTasksInput) => TaskListPage;

const EMPTY_PAGE: TaskListPage = { tasks: [], total: 0, nextCursor: null };

export function admitTaskOwner(
  db: Database,
  taskId: string,
  caller: OperationCaller,
  admission: TaskReadAdmission
): { value: string } | { reason: null } {
  const owner = resolveSpaceTaskOwner(db, taskId);
  return owner === null || 'value' in admitSpaceTaskCaller(owner, caller, admission)
    ? { value: taskId }
    : { reason: null };
}

export function admitSpaceScope(
  spaceId: string | undefined,
  caller: OperationCaller,
  admission: TaskReadAdmission
): { value: true } | { reason: null } {
  return spaceId === undefined ||
    'value' in admitSpaceTaskCaller({ kind: 'space', spaceId }, caller, admission)
    ? { value: true }
    : { reason: null };
}

export function admitListedScope(
  input: ListTasksInput,
  caller: OperationCaller,
  admission: TaskReadAdmission
): { value: true } | { reason: TaskListPage } {
  return 'value' in admitSpaceScope(input.spaceId, caller, admission)
    ? { value: true }
    : { reason: EMPTY_PAGE };
}

function loadTask(readTask: TaskReader, taskId: string): { value: TaskCore } | { reason: null } {
  const task = readTask(taskId);
  return task ? { value: task } : { reason: null };
}

function loadTaskByNumber(
  readByNumber: TaskNumberReader,
  spaceId: string,
  taskNumber: number
): TaskCore | null {
  return readByNumber(spaceId, taskNumber);
}

function loadPage(listTasks: TaskPageReader, input: ListTasksInput): TaskListPage {
  return listTasks(input);
}

export const readScopedTask = (superpipe({})('read-scoped-task') as PipelineAPI)
  .input(['db', 'caller', 'admission', 'readTask', 'taskId'])
  .pipe(admitTaskOwner, ['db', 'taskId', 'caller', 'admission'], 'result:task')
  .pipe(loadTask, ['readTask', 'task'], 'result:task')
  .end('task') as (
  db: Database,
  caller: OperationCaller,
  admission: TaskReadAdmission,
  readTask: TaskReader,
  taskId: string
) => TaskCore | null;

export const readScopedTaskByNumber = (superpipe({})('read-scoped-task-by-number') as PipelineAPI)
  .input(['caller', 'admission', 'readByNumber', 'spaceId', 'taskNumber'])
  .pipe(admitSpaceScope, ['spaceId', 'caller', 'admission'], 'result:task')
  .pipe(loadTaskByNumber, ['readByNumber', 'spaceId', 'taskNumber'], 'task')
  .end('task') as (
  caller: OperationCaller,
  admission: TaskReadAdmission,
  readByNumber: TaskNumberReader,
  spaceId: string,
  taskNumber: number
) => TaskCore | null;

export const listScopedTasks = (superpipe({})('list-scoped-tasks') as PipelineAPI)
  .input(['caller', 'admission', 'listTasks', 'input'])
  .pipe(admitListedScope, ['input', 'caller', 'admission'], 'result:page')
  .pipe(loadPage, ['listTasks', 'input'], 'page')
  .end('page') as (
  caller: OperationCaller,
  admission: TaskReadAdmission,
  listTasks: TaskPageReader,
  input: ListTasksInput
) => TaskListPage;
