import type { SpaceBlockReason } from '@hyperneo/shared/types/space';
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
  blockReason?: SpaceBlockReason | null;
  blockReasonNotIn?: SpaceBlockReason[];
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt';
  before?: TaskListCursor;
}

export interface TaskListPage {
  tasks: TaskCore[];
  total: number;
  nextCursor: TaskListCursor | null;
}

interface TaskListQuery {
  sql: string;
  values: SQLiteValue[];
  countSql: string;
  countValues: SQLiteValue[];
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
  if (input.blockReason !== undefined) {
    if (input.blockReason === null) {
      where.push('block_reason IS NULL');
    } else {
      where.push('block_reason = ?');
      values.push(input.blockReason);
    }
  } else if (input.blockReasonNotIn && input.blockReasonNotIn.length > 0) {
    const placeholders = input.blockReasonNotIn.map(() => '?').join(', ');
    where.push(`(block_reason IS NULL OR block_reason NOT IN (${placeholders}))`);
    for (const reason of input.blockReasonNotIn) values.push(reason);
  }
  const countSql = `SELECT COUNT(*) AS total FROM space_tasks WHERE ${where.join(' AND ')}`;
  const countValues = [...values];
  if (input.before) {
    where.push('(created_at, id) < (?, ?)');
    values.push(input.before.createdAt, input.before.id);
  }
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset!)) : 0;
  const whereSql = where.join(' AND ');
  values.push(limit + 1, offset);
  return {
    sql: `SELECT * FROM space_tasks WHERE ${whereSql} ORDER BY ${
      input.orderBy === 'updatedAt' ? 'updated_at' : 'created_at'
    } DESC, id DESC LIMIT ? OFFSET ?`,
    values,
    countSql,
    countValues,
    limit,
  };
}

function countTaskListRows(db: Database, query: TaskListQuery): number {
  const row = db.prepare(query.countSql).get(...query.countValues) as
    | { total?: number }
    | undefined;
  return row?.total ?? 0;
}

function selectTaskListRows(db: Database, query: TaskListQuery): Record<string, unknown>[] {
  return db.prepare(query.sql).all(...query.values) as Record<string, unknown>[];
}

function toTaskListPage(
  rows: Record<string, unknown>[],
  query: TaskListQuery,
  total: number
): TaskListPage {
  const tasks = rows.slice(0, query.limit).map(decodeTaskCoreRow);
  const last = tasks.at(-1);
  return {
    tasks,
    total,
    nextCursor:
      rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export const listTaskCores = (superpipe({})('list-core-tasks') as PipelineAPI)
  .input(['db', 'input'])
  .pipe(buildTaskListQuery, 'input', 'query')
  .pipe(countTaskListRows, ['db', 'query'], 'total')
  .pipe(selectTaskListRows, ['db', 'query'], 'rows')
  .pipe(toTaskListPage, ['rows', 'query', 'total'], 'page')
  .end('page') as (db: Database, input: ListTasksInput) => TaskListPage;
