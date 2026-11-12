import type { Database } from '../sqlite-compat.ts';
import { requireGitHubScopeSettingsTable } from './github-scope.ts';

export function persistGitHubPollingIntent(
  db: Database,
  spaceId: string,
  enabled: boolean,
  now: number
): void {
  const table = requireGitHubScopeSettingsTable(db, spaceId);
  db.prepare(
    `INSERT INTO ${table} (space_id, enabled, polling_intent, created_at, updated_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET polling_intent = excluded.polling_intent, updated_at = excluded.updated_at`
  ).run(spaceId, enabled ? 1 : 0, now, now);
}
