import type { TaskCore } from '@hyperneo/shared/types/task-core';

export function decodeTaskCoreRow(row: Record<string, unknown>): TaskCore {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    status: row.status as TaskCore['status'],
    priority: row.priority as TaskCore['priority'],
    labels: JSON.parse((row.labels as string | null) ?? '[]') as string[],
    result: (row.result as string | null) ?? null,
    dependsOn: JSON.parse((row.depends_on as string | null) ?? '[]') as string[],
    archivedAt: (row.archived_at as number | null) ?? null,
    createdAt: row.created_at as number,
    startedAt: (row.started_at as number | null) ?? null,
    completedAt: (row.completed_at as number | null) ?? null,
    updatedAt: (row.updated_at as number | null) ?? (row.created_at as number),
  };
}
