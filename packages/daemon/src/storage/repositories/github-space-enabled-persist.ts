import type { Database } from '../sqlite-compat.ts';
import { requireGitHubScopeSettingsTable, requireGitHubScopeTable } from './github-scope.ts';

export function persistGitHubSpaceEnabled(
  db: Database,
  spaceId: string,
  enabled: boolean,
  now: number
): number {
  const settingsTable = requireGitHubScopeSettingsTable(db, spaceId);
  const watchedTable = requireGitHubScopeTable(db, spaceId);
  db.prepare(
    `INSERT INTO ${settingsTable} (space_id, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).run(spaceId, enabled ? 1 : 0, now, now);
  return db
    .prepare(`UPDATE ${watchedTable} SET enabled = ?, updated_at = ? WHERE space_id = ?`)
    .run(enabled ? 1 : 0, now, spaceId).changes;
}
