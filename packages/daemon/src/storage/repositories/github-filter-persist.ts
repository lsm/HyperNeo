import type { Database } from '../sqlite-compat.ts';

export function persistGitHubFilterCurrentUser(
  db: Database,
  spaceId: string,
  enabled: boolean,
  now: number
): void {
  db.prepare(
    `INSERT INTO space_github_source_settings (space_id, enabled, filter_current_user, created_at, updated_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET filter_current_user = excluded.filter_current_user, updated_at = excluded.updated_at`
  ).run(spaceId, enabled ? 1 : 0, now, now);
}
