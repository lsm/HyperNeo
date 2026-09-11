import type { TaskCore } from '@hyperneo/shared/types/task-core';
import superpipe, { type PipelineAPI } from 'superpipe';
import { planTaskDependencies } from '../../lib/tasks/dependency-plan.ts';
import type { TaskDependencyNode } from '../../lib/tasks/dependency-graph.ts';
import type { Database } from '../sqlite-compat.ts';
import { decodeTaskCoreRow } from './task-row.ts';

type Rejection = Extract<ReturnType<typeof planTaskDependencies>, string>;
export interface SetTaskDependenciesInput {
  taskId: string;
  dependsOn: string[];
}

function selectDependencyScope(
  db: Database,
  input: SetTaskDependenciesInput
): { value: TaskDependencyNode[] } | { reason: null } {
  const target = db
    .prepare('SELECT id FROM space_tasks WHERE id = ? AND space_id IS NULL')
    .get(input.taskId);
  if (!target) return { reason: null };
  const rows = db
    .prepare('SELECT id, depends_on FROM space_tasks WHERE space_id IS NULL')
    .all() as { id: string; depends_on: string | null }[];
  return {
    value: rows.map((row) => ({
      id: row.id,
      dependsOn: JSON.parse(row.depends_on ?? '[]') as string[],
    })),
  };
}

export function decideTaskDependencyReplacement(
  tasks: readonly TaskDependencyNode[],
  input: SetTaskDependenciesInput
): { value: string[] } | { reason: Rejection } {
  const result = planTaskDependencies(tasks, input.taskId, input.dependsOn);
  return typeof result === 'string' ? { reason: result } : { value: result };
}

function writeTaskDependencies(
  db: Database,
  input: SetTaskDependenciesInput,
  dependsOn: string[],
  now: number
): TaskCore {
  const row = db
    .prepare(
      'UPDATE space_tasks SET depends_on = ?, updated_at = ? WHERE id = ? AND space_id IS NULL RETURNING *'
    )
    .get(JSON.stringify(dependsOn), now, input.taskId) as Record<string, unknown> | null;
  if (!row) throw new Error('Standalone task disappeared during dependency replacement');
  return decodeTaskCoreRow(row);
}

const persistTaskDependencies = (
  superpipe({})('persist-standalone-task-dependencies') as PipelineAPI
)
  .input(['db', 'input'])
  .pipe(selectDependencyScope, ['db', 'input'], 'result:dependencies')
  .pipe(decideTaskDependencyReplacement, ['dependencies', 'input'], 'result:dependencies')
  .pipe(Date.now, undefined, 'now')
  .pipe(writeTaskDependencies, ['db', 'input', 'dependencies', 'now'], 'dependencies')
  .end('dependencies') as (
  db: Database,
  input: SetTaskDependenciesInput
) => TaskCore | Rejection | null;

export function setStandaloneTaskDependencies(
  db: Database,
  input: SetTaskDependenciesInput,
  notifyChange: () => void
): TaskCore | Rejection | null {
  const active = 'inTransaction' in db ? Boolean(db.inTransaction) : db.isTransaction;
  if (active) throw new Error('Task dependencies require their own transaction');
  const result = db.transaction(() => persistTaskDependencies(db, input))();
  if (result !== null && typeof result !== 'string') notifyChange();
  return result;
}
