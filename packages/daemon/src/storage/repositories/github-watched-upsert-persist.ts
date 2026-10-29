import { generateUUID } from '@hyperneo/shared';
import type { Database } from '../sqlite-compat.ts';
import type {
  GitHubEventExtensionRepository,
  GitHubWatchedRepo,
} from '../../lib/external-events/github/github-repository.ts';
import { findGitHubWatchedRepo, findGitHubWatchedRepoById } from './github-watched-repo-lookups.ts';
import { readGitHubSpaceEnabled } from './github-space-settings-read.ts';
import { persistGitHubWatchedRepoUpdate } from './github-watched-update-persist.ts';
import { persistGitHubWatchedRepoInsert } from './github-watched-insert-persist.ts';
import { persistGitHubPollCursorJson } from './github-cursor-persist.ts';
type Params = Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];

export function upsertGitHubWatchedRepo(db: Database, params: Params): GitHubWatchedRepo {
  const now = Date.now();
  const existing = findGitHubWatchedRepo(db, params.spaceId, params.owner, params.repo);
  const wasActive = existing?.enabled && existing?.pollingEnabled;
  const nextEnabled = params.enabled === undefined ? (existing?.enabled ?? true) : params.enabled;
  const nextPolling = params.pollingEnabled ?? existing?.pollingEnabled ?? false;
  const willBeActive = nextEnabled && nextPolling;
  const pollingNewlyEnabled = willBeActive && !wasActive;
  if (existing) {
    persistGitHubWatchedRepoUpdate(db, params, existing, now);
  } else {
    const id = generateUUID();
    const spaceEnabled = params.enabled ?? readGitHubSpaceEnabled(db, params.spaceId);
    persistGitHubWatchedRepoInsert(db, params, id, spaceEnabled, now);
  }
  const watched = findGitHubWatchedRepo(db, params.spaceId, params.owner, params.repo)!;
  if (pollingNewlyEnabled) {
    const cursor = watched.pollCursor ?? {};
    cursor.checkRunPollingEnabledAt = now;
    delete cursor.checkRunHeadLastSeenAt;
    delete cursor.checkRunHeadPendingLastSeenAt;
    delete cursor.endpointLastSeenAt?.check_runs;
    delete cursor.endpointPendingLastSeenAt?.check_runs;
    persistGitHubPollCursorJson(db, watched.id, cursor);
  }
  return findGitHubWatchedRepoById(db, watched.id)!;
}
