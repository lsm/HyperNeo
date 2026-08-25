import { slugify, resolveCollision } from './slug.ts';

export function worktreeSlug(
  taskTitle: string,
  taskNumber: number,
  existingSlugs: string[] = []
): string {
  if (!/[a-z0-9]/i.test(taskTitle)) {
    return resolveCollision(`task-${taskNumber}`, existingSlugs);
  }

  return slugify(taskTitle, existingSlugs);
}
