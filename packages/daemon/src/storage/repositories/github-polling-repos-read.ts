import type { Database } from '../sqlite-compat.ts';
import type { GitHubWatchedRepo } from '../../lib/external-events/github/github-repository.ts';
import { mapGitHubWatchedRepo } from './github-watched-repos-read.ts';
import {
  countGitHubPollingIntentRows,
  selectGitHubSpaceJoinedPollingRows,
  selectGitHubWatchedRows,
} from './github-scope.ts';

export function countGitHubSpacesWithPollingIntent(db: Database): number {
  return countGitHubPollingIntentRows(db);
}

export function listGitHubPollingRepos(db: Database, spaceId?: string): GitHubWatchedRepo[] {
  return selectGitHubWatchedRows(db, spaceId, 'enabled = 1 AND polling_enabled = 1').map(
    mapGitHubWatchedRepo
  );
}

export function listGitHubPollingConfiguredRepos(
  db: Database,
  spaceId?: string
): GitHubWatchedRepo[] {
  return selectGitHubSpaceJoinedPollingRows(db, spaceId).map(mapGitHubWatchedRepo);
}
