import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import { decodeTaskCoreRow } from './task-row.ts';

function selectTaskRow(
  db: Database,
  taskId: string
): { value: Record<string, unknown> } | { reason: null } {
  const row = db.prepare('SELECT * FROM space_tasks WHERE id = ?').get(taskId) as Record<
    string,
    unknown
  > | null;
  return row ? { value: row } : { reason: null };
}

export const readTaskCore = (superpipe({})('read-task-core') as PipelineAPI)
  .input(['db', 'taskId'])
  .pipe(selectTaskRow, ['db', 'taskId'], 'result:task')
  .pipe(decodeTaskCoreRow, 'task', 'task')
  .end('task') as (db: Database, taskId: string) => TaskCore | null;
