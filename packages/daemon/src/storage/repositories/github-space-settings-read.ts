import type { Database } from '../sqlite-compat.ts';

export function readGitHubSpaceEnabled(db: Database, spaceId: string): boolean {
  const row = db
    .prepare(`SELECT enabled FROM space_github_source_settings WHERE space_id = ?`)
    .get(spaceId) as { enabled: number } | undefined;
  return row ? row.enabled === 1 : true;
}

export function readGitHubPollingIntent(db: Database, spaceId: string): boolean {
  const row = db
    .prepare(
      'SELECT polling_intent AS pollingIntent FROM space_github_source_settings WHERE space_id = ?'
    )
    .get(spaceId) as { pollingIntent: number } | undefined;
  return row ? row.pollingIntent === 1 : false;
}

export function readGitHubFilterCurrentUser(db: Database, spaceId: string): boolean {
  const row = db
    .prepare(
      'SELECT filter_current_user AS filterCurrentUser FROM space_github_source_settings WHERE space_id = ?'
    )
    .get(spaceId) as { filterCurrentUser: number } | undefined;
  return row ? row.filterCurrentUser === 1 : true;
}
