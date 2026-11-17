import { existsSync } from 'node:fs';
import { WorkArchivedSchema, workResultSchema } from '../drivers/types.ts';
import type { OperationOutcome } from '../operations/invoke.ts';

const Archived = workResultSchema(WorkArchivedSchema);

export async function releaseWorkCleanup(
  folder: string,
  todoIds: readonly string[],
  fence: () => Promise<boolean | 'not_started_by_us'>,
  archive: () => Promise<OperationOutcome>,
  record: (todoId: string, receipt: unknown) => Promise<unknown>
): Promise<true | { keep: string }> {
  const fenced = await fence();
  if (fenced === 'not_started_by_us') return { keep: fenced };
  if (!fenced) return { keep: 'live' };
  const result = await archive();
  if (result.kind !== 'completed') return { keep: 'archive_failed' };
  const parsed = Archived.safeParse(result.value);
  if (!parsed.success) return { keep: 'archive_unreadable' };
  if (!parsed.data.ok) return { keep: parsed.data.detail };
  if (existsSync(folder)) return { keep: parsed.data.value.worktree?.reason ?? 'archive_kept' };
  for (const todoId of todoIds) await record(todoId, result.value);
  return true;
}
