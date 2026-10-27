import type { TaskCore } from '@hyperneo/shared/types/task-core';
import { planTaskDependencies } from '../../lib/tasks/dependency-plan.ts';
import type { DependencyNode } from '../../lib/work-queue/dependency-graph.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
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
): { value: DependencyNode[] } | { reason: null } {
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
  tasks: readonly DependencyNode[],
  input: SetTaskDependenciesInput
): { value: string[] } | { reason: Rejection } {
  const result = planTaskDependencies(tasks, input.taskId, input.dependsOn);
  return typeof result === 'string' ? { reason: result } : { value: result };
}

export function planStandaloneTaskDependencies(
  db: Database,
  input: SetTaskDependenciesInput
): { value: string[] } | { reason: Rejection | null } {
  const scope = selectDependencyScope(db, input);
  return 'reason' in scope ? scope : decideTaskDependencyReplacement(scope.value, input);
}

function editWithDependencies(
  db: Database,
  input: EditStandaloneTaskInput
): TaskCore | Rejection | null {
  if (input.dependsOn === undefined) return applyStandaloneTaskEdit(db, input);
  const planned = planStandaloneTaskDependencies(db, {
    taskId: input.taskId,
    dependsOn: input.dependsOn,
  });
  return 'reason' in planned
    ? planned.reason
    : applyStandaloneTaskEdit(db, { ...input, dependsOn: planned.value });
}

export const editStandaloneTaskWithDependencies = defineDbOp<
  EditStandaloneTaskInput,
  TaskCore | Rejection | null
>({
  name: 'tasks.editStandalone',
  mode: 'write',
  run: (db, input, changes) => {
    const result = editWithDependencies(db, input);
    if (result !== null && typeof result !== 'string') changes.notifyChange('space_tasks');
    return result;
  },
});
