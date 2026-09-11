import type { TaskCore, TaskPriority } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';
import { decodeTaskCoreRow } from './task-row.ts';

export interface EditStandaloneTaskInput {
  taskId: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
}

interface TaskEditQuery {
  sql: string;
  values: SQLiteValue[];
}

function buildTaskEditQuery(input: EditStandaloneTaskInput, now: number): TaskEditQuery {
  const assignments: string[] = [];
  const values: SQLiteValue[] = [];
  for (const key of ['title', 'description', 'priority', 'labels'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    assignments.push(`${key} = ?`);
    values.push(key === 'labels' ? JSON.stringify(value) : (value as string));
  }
  if (assignments.length === 0) throw new Error('Task edit requires at least one field');
  assignments.push('updated_at = ?');
  values.push(now, input.taskId);
  return {
    sql: `UPDATE space_tasks SET ${assignments.join(', ')} WHERE id = ? AND space_id IS NULL RETURNING *`,
    values,
  };
}

function updateStandaloneTask(
  db: Database,
  query: TaskEditQuery
): { value: Record<string, unknown> } | { reason: null } {
  const row = db.prepare(query.sql).get(...query.values) as Record<string, unknown> | null;
  return row ? { value: row } : { reason: null };
}

function notifyTaskEdited(notifyChange: () => void): void {
  notifyChange();
}

export const editStandaloneTask = (superpipe({})('edit-standalone-task') as PipelineAPI)
  .input(['db', 'input', 'notifyChange'])
  .pipe(Date.now, undefined, 'now')
  .pipe(buildTaskEditQuery, ['input', 'now'], 'query')
  .pipe(updateStandaloneTask, ['db', 'query'], 'result:task')
  .pipe(decodeTaskCoreRow, 'task', 'task')
  .pipe(notifyTaskEdited, 'notifyChange')
  .end('task') as (
  db: Database,
  input: EditStandaloneTaskInput,
  notifyChange: () => void
) => TaskCore | null;
