import { slugify, resolveCollision } from './slug';

/**
 * Generate a slug for a worktree folder name and git branch.
 *
 * Delegates to `slugify()` for core slugification rules.
 * If the task title contains no alphanumeric characters (empty, whitespace-only,
 * or all-special-chars), falls back to `task-{taskNumber}`.
 *
 * The returned slug is used as:
 * - The worktree folder name (as-is)
 * - The git branch name (prefixed with `space/`)
 *
 * @param taskTitle - The task title to slugify
 * @param taskNumber - The numeric task ID for fallback naming
 * @param existingSlugs - Slugs already in use, for collision avoidance
 * @returns A unique, URL-safe slug
 */
export function worktreeSlug(
  taskTitle: string,
  taskNumber: number,
  existingSlugs: string[] = []
): string {
  // Detect whether the title contains any usable (alphanumeric) characters
  // before delegating. This avoids coupling to slug.ts' internal sentinel value
  // ('unnamed-space') and prevents false positives for titles like "Unnamed Space".
  if (!/[a-z0-9]/i.test(taskTitle)) {
    return resolveCollision(`task-${taskNumber}`, existingSlugs);
  }

  return slugify(taskTitle, existingSlugs);
}
