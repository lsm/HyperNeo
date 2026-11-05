import type { Database } from '../sqlite-compat.ts';
import { schemaTableExists } from '../schema/extensions.ts';
import type { GitHubWatchedRepo } from '../../lib/external-events/github/github-repository.ts';
import { mapGitHubWatchedRepo } from './github-watched-repos-read.ts';

export function countGitHubSpacesWithPollingIntent(db: Database): number {
  if (!schemaTableExists(db, 'spaces')) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM space_github_source_settings s
         JOIN spaces sp ON sp.id = s.space_id
         WHERE s.polling_intent = 1`
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function listGitHubPollingRepos(db: Database, spaceId?: string): GitHubWatchedRepo[] {
  const rows = spaceId
    ? (db
        .prepare(
          `SELECT * FROM space_github_watched_repos WHERE space_id = ? AND enabled = 1 AND polling_enabled = 1 ORDER BY owner, repo`
        )
        .all(spaceId) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT * FROM space_github_watched_repos WHERE enabled = 1 AND polling_enabled = 1 ORDER BY space_id, owner, repo`
        )
        .all() as Record<string, unknown>[]);
  return rows.map((r) => mapGitHubWatchedRepo(r));
}

export function listGitHubPollingConfiguredRepos(
  db: Database,
  spaceId?: string
): GitHubWatchedRepo[] {
  if (!schemaTableExists(db, 'spaces')) return [];
  const rows = spaceId
    ? (db
        .prepare(
          `SELECT r.* FROM space_github_watched_repos r
             JOIN spaces sp ON sp.id = r.space_id
             WHERE r.space_id = ? AND r.polling_enabled = 1
             ORDER BY r.owner, r.repo`
        )
        .all(spaceId) as Record<string, unknown>[])
    : (db
        .prepare(
          `SELECT r.* FROM space_github_watched_repos r
             JOIN spaces sp ON sp.id = r.space_id
             WHERE r.polling_enabled = 1
             ORDER BY r.space_id, r.owner, r.repo`
        )
        .all() as Record<string, unknown>[]);
  return rows.map((r) => mapGitHubWatchedRepo(r));
}
