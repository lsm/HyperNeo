import { generateUUID } from '@hyperneo/shared';
import type { TaskCore, TaskPriority } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { type ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { decodeTaskCoreRow } from './task-row.ts';

export interface CreateStandaloneTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
}

function insertStandaloneTask(
  db: Database,
  input: CreateStandaloneTaskInput,
  creatorSessionId: string | undefined,
  id: string,
  now: number
): Record<string, unknown> {
  return db
    .prepare(`INSERT INTO space_tasks (
    id, space_id, task_number, title, description, status, priority, labels,
    depends_on, created_by_session, created_at, updated_at
  ) VALUES (?, NULL, NULL, ?, ?, 'open', ?, ?, '[]', ?, ?, ?) RETURNING *`)
    .get(
      id,
      input.title,
      input.description ?? '',
      input.priority ?? 'normal',
      JSON.stringify(input.labels ?? []),
      creatorSessionId ?? null,
      now,
      now
    ) as Record<string, unknown>;
}

function notifyTaskCreated(changes: Pick<ChangeRecorder, 'notifyChange'>): void {
  changes.notifyChange('space_tasks');
}

const insertAndAnnounceStandaloneTask = (superpipe({})('create-standalone-task') as PipelineAPI)
  .input(['db', 'input', 'creatorSessionId', 'changes'])
  .pipe(generateUUID, undefined, 'id')
  .pipe(Date.now, undefined, 'now')
  .pipe(insertStandaloneTask, ['db', 'input', 'creatorSessionId', 'id', 'now'], 'row')
  .pipe(decodeTaskCoreRow, 'row', 'task')
  .pipe(notifyTaskCreated, 'changes')
  .end('task') as (
  db: Database,
  input: CreateStandaloneTaskInput,
  creatorSessionId: string | undefined,
  changes: Pick<ChangeRecorder, 'notifyChange'>
) => TaskCore;

export interface CreateStandaloneTaskArgs {
  input: CreateStandaloneTaskInput;
  creatorSessionId?: string;
}

export const createStandaloneTask = defineDbOp<CreateStandaloneTaskArgs, TaskCore>({
  name: 'tasks.createStandalone',
  mode: 'write',
  run: (db, { input, creatorSessionId }, changes) =>
    insertAndAnnounceStandaloneTask(db, input, creatorSessionId, changes),
});
