import type { TaskCore, TaskLifecycleStatus } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import { decodeTaskCoreRow } from './task-row.ts';

export interface TaskListCursor {
  createdAt: number;
  id: string;
}

export interface ListTasksInput {
  spaceId?: string;
  status?: TaskLifecycleStatus;
  limit?: number;
  before?: TaskListCursor;
}

export interface TaskListPage {
  tasks: TaskCore[];
  nextCursor: TaskListCursor | null;
}

interface TaskListQuery {
  sql: string;
  values: SQLiteValue[];
  limit: number;
}

function buildTaskListQuery(input: ListTasksInput): TaskListQuery {
  const limit = Number.isFinite(input.limit)
    ? Math.max(1, Math.min(100, Math.trunc(input.limit!)))
    : 50;
  const where = [input.spaceId === undefined ? 'space_id IS NULL' : 'space_id = ?'];
  const values: SQLiteValue[] = input.spaceId === undefined ? [] : [input.spaceId];
  if (input.status !== undefined) {
    where.push('status = ?');
    values.push(input.status);
  } else {
    where.push("status != 'archived'");
  }
  if (input.before) {
    where.push('(created_at, id) < (?, ?)');
    values.push(input.before.createdAt, input.before.id);
  }
  values.push(limit + 1);
  return {
    sql: `SELECT * FROM space_tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    values,
    limit,
  };
}

function selectTaskListRows(db: Database, query: TaskListQuery): Record<string, unknown>[] {
  return db.prepare(query.sql).all(...query.values) as Record<string, unknown>[];
}

function toTaskListPage(rows: Record<string, unknown>[], query: TaskListQuery): TaskListPage {
  const tasks = rows.slice(0, query.limit).map(decodeTaskCoreRow);
  const last = tasks.at(-1);
  return {
    tasks,
    nextCursor:
      rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export const listTaskCores = (superpipe({})('list-core-tasks') as PipelineAPI)
  .input(['db', 'input'])
  .pipe(buildTaskListQuery, 'input', 'query')
  .pipe(selectTaskListRows, ['db', 'query'], 'rows')
  .pipe(toTaskListPage, ['rows', 'query'], 'page')
  .end('page') as (db: Database, input: ListTasksInput) => TaskListPage;
