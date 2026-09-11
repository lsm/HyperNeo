import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  planStandaloneTaskTransition,
  type StandaloneTaskTransitionInput,
  type StandaloneTaskLifecyclePatch,
} from '../../lib/tasks/standalone-lifecycle.ts';
import type { Database } from '../sqlite-compat.ts';
import { decodeTaskCoreRow } from './task-row.ts';

type Rejection = Extract<ReturnType<typeof planStandaloneTaskTransition>, string>;
export interface TransitionStandaloneTaskInput extends StandaloneTaskTransitionInput {
  taskId: string;
}

function selectStandaloneTask(
  db: Database,
  input: TransitionStandaloneTaskInput
): { value: TaskCore } | { reason: null } {
  const row = db
    .prepare('SELECT * FROM space_tasks WHERE id = ? AND space_id IS NULL')
    .get(input.taskId) as Record<string, unknown> | null;
  return row ? { value: decodeTaskCoreRow(row) } : { reason: null };
}

export function decidePersistedTaskTransition(
  task: TaskCore,
  input: StandaloneTaskTransitionInput,
  now: number
): { value: StandaloneTaskLifecyclePatch } | { reason: Rejection } {
  const decision = planStandaloneTaskTransition(task, input, now);
  return typeof decision === 'string' ? { reason: decision } : { value: decision };
}

function writeTaskTransition(
  db: Database,
  input: TransitionStandaloneTaskInput,
  patch: StandaloneTaskLifecyclePatch
): TaskCore {
  const row = db
    .prepare(`UPDATE space_tasks SET status = ?, started_at = ?, completed_at = ?,
    archived_at = ?, result = ?, updated_at = ? WHERE id = ? AND space_id IS NULL RETURNING *`)
    .get(
      patch.status,
      patch.startedAt,
      patch.completedAt,
      patch.archivedAt,
      patch.result,
      patch.updatedAt,
      input.taskId
    ) as Record<string, unknown> | null;
  if (!row) throw new Error('Standalone task disappeared during transition');
  return decodeTaskCoreRow(row);
}

const persistTaskTransition = (superpipe({})('persist-standalone-task-transition') as PipelineAPI)
  .input(['db', 'input'])
  .pipe(selectStandaloneTask, ['db', 'input'], 'result:transition')
  .pipe(Date.now, undefined, 'now')
  .pipe(decidePersistedTaskTransition, ['transition', 'input', 'now'], 'result:transition')
  .pipe(writeTaskTransition, ['db', 'input', 'transition'], 'transition')
  .end('transition') as (
  db: Database,
  input: TransitionStandaloneTaskInput
) => TaskCore | Rejection | null;

export function transitionStandaloneTask(
  db: Database,
  input: TransitionStandaloneTaskInput,
  notifyChange: () => void
): TaskCore | Rejection | null {
  const active = 'inTransaction' in db ? Boolean(db.inTransaction) : db.isTransaction;
  if (active) throw new Error('Task transition requires its own transaction');
  const result = db.transaction(() => persistTaskTransition(db, input))();
  if (result !== null && typeof result !== 'string') notifyChange();
  return result;
}
