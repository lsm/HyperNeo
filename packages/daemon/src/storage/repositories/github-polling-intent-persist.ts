import type { Database } from '../sqlite-compat.ts';

export function persistGitHubPollingIntent(
  db: Database,
  spaceId: string,
  enabled: boolean,
  now: number
): void {
  db.prepare(
    `INSERT INTO space_github_source_settings (space_id, enabled, polling_intent, created_at, updated_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET polling_intent = excluded.polling_intent, updated_at = excluded.updated_at`
  ).run(spaceId, enabled ? 1 : 0, now, now);
}
