import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { planTaskDependencies } from '../../lib/tasks/dependency-plan.ts';
import type { TaskDependencyNode } from '../../lib/tasks/dependency-graph.ts';
import type { Database } from '../sqlite-compat.ts';
import { applyStandaloneTaskEdit, type EditStandaloneTaskInput } from './edit-task.ts';

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
    .prepare('SELECT id, depends_on, status FROM space_tasks WHERE space_id IS NULL')
    .all() as { id: string; depends_on: string | null; status: string }[];
  return {
    value: rows.map((row) => ({
      id: row.id,
      dependsOn: JSON.parse(row.depends_on ?? '[]') as string[],
      status: row.status,
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

function requireOwnTransaction(db: Database): void {
  const active = 'inTransaction' in db ? Boolean(db.inTransaction) : db.isTransaction;
  if (active) throw new Error('Task dependencies require their own transaction');
}

export function planStandaloneTaskDependencies(
  db: Database,
  input: SetTaskDependenciesInput
): { value: string[] } | { reason: Rejection | null } {
  const scope = selectDependencyScope(db, input);
  return 'reason' in scope ? scope : decideTaskDependencyReplacement(scope.value, input);
}

export function editStandaloneTaskWithDependencies(
  db: Database,
  input: EditStandaloneTaskInput,
  notifyChange: () => void
): TaskCore | Rejection | null {
  requireOwnTransaction(db);
  const result = db.transaction(() => {
    if (input.dependsOn === undefined) return applyStandaloneTaskEdit(db, input);
    const planned = planStandaloneTaskDependencies(db, {
      taskId: input.taskId,
      dependsOn: input.dependsOn,
    });
    return 'reason' in planned
      ? planned.reason
      : applyStandaloneTaskEdit(db, { ...input, dependsOn: planned.value });
  })();
  if (result !== null && typeof result !== 'string') notifyChange();
  return result;
}
