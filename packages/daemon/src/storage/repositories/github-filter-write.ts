import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { persistGitHubFilterCurrentUser } from './github-filter-persist.ts';
import { listGitHubWatchedRepos } from './github-watched-repos-read.ts';
import {
  readGitHubSpaceEnabled,
  readGitHubPollingIntent,
  readGitHubFilterCurrentUser,
} from './github-space-settings-read.ts';
import { persistSpaceExtensionConfig } from './space-extension-config-persist.ts';
import { projectGitHubWatchedRepo } from '../../lib/external-events/github/github-watched-projection.ts';

class GitHubFilterWriter {
  constructor(private readonly db: Database) {}

  persist(spaceId: string, enabled: boolean, now: number) {
    if (!spaceId || spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
      throw new Error('Space id must be non-empty and must not include edge whitespace');
    }
    persistGitHubFilterCurrentUser(this.db, spaceId, enabled, now);
    const repos = listGitHubWatchedRepos(this.db, spaceId);
    const config = {
      spaceId,
      source: 'github',
      enabled: readGitHubSpaceEnabled(this.db, spaceId),
      settings: {
        pollingIntent: readGitHubPollingIntent(this.db, spaceId),
        filterCurrentUser: readGitHubFilterCurrentUser(this.db, spaceId),
        watchedRepos: repos.map(projectGitHubWatchedRepo),
      },
    };
    persistSpaceExtensionConfig(this.db, spaceId, 'github', config, now);
    return { config };
  }
}

export const gitHubFilterWrites = defineRepositoryOp(
  'github.space.filter.write',
  'write',
  GitHubFilterWriter,
  ['persist'] as const
);
