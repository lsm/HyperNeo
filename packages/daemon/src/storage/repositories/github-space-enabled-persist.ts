import type { Database } from '../sqlite-compat.ts';

export function persistGitHubSpaceEnabled(
  db: Database,
  spaceId: string,
  enabled: boolean,
  now: number
): number {
  db.prepare(
    `INSERT INTO space_github_source_settings (space_id, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(spaceId, enabled ? 1 : 0, now, now);
  return db
    .prepare(`UPDATE space_github_watched_repos SET enabled = ?, updated_at = ? WHERE space_id = ?`)
    .run(enabled ? 1 : 0, now, spaceId).changes;
}
