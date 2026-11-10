import type { Database } from '../sqlite-compat.ts';
import type { GitHubWatchedRepo } from '../../lib/external-events/github/github-repository.ts';
import { mapGitHubWatchedRepo } from './github-watched-repos-read.ts';

export function findGitHubWatchedRepo(
  db: Database,
  spaceId: string,
  owner: string,
  repo: string
): GitHubWatchedRepo | null {
  const row = db
    .prepare(
      `SELECT * FROM space_github_watched_repos WHERE space_id = ? AND lower(owner)=lower(?) AND lower(repo)=lower(?)`
    )
    .get(spaceId, owner, repo) as Record<string, unknown> | undefined;
  return row ? mapGitHubWatchedRepo(row) : null;
}

export function findGitHubWatchedRepoById(db: Database, id: string): GitHubWatchedRepo | null {
  const row = db.prepare(`SELECT * FROM space_github_watched_repos WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapGitHubWatchedRepo(row) : null;
}
