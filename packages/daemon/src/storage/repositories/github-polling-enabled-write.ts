import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { upsertGitHubWatchedRepo } from './github-watched-upsert-persist.ts';
import { persistGitHubPollingIntent } from './github-polling-intent-persist.ts';
import { listGitHubWatchedRepos } from './github-watched-repos-read.ts';
import {
  readGitHubSpaceEnabled,
  readGitHubPollingIntent,
  readGitHubFilterCurrentUser,
} from './github-space-settings-read.ts';
import { persistSpaceExtensionConfig } from './space-extension-config-persist.ts';
import { projectGitHubWatchedRepo } from '../../lib/external-events/github/github-watched-projection.ts';

export const gitHubPollingWrites = defineDbOp({
  name: 'github.space.polling.write',
  mode: 'write',
  run(db: Database, { spaceId, enabled }: { spaceId: string; enabled: boolean }) {
    if (!spaceId || spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
      throw new Error('Space id must be non-empty and must not include edge whitespace');
    }
    for (const watched of listGitHubWatchedRepos(db, spaceId)) {
      if (enabled && watched.webhookEnabled && watched.webhookSecret) continue;
      const { owner, repo } = watched;
      upsertGitHubWatchedRepo(db, { spaceId, owner, repo, pollingEnabled: enabled });
    }
    const now = Date.now();
    persistGitHubPollingIntent(db, spaceId, enabled, now);
    const config = {
      spaceId,
      source: 'github',
      enabled: readGitHubSpaceEnabled(db, spaceId),
      settings: {
        pollingIntent: readGitHubPollingIntent(db, spaceId),
        filterCurrentUser: readGitHubFilterCurrentUser(db, spaceId),
        watchedRepos: listGitHubWatchedRepos(db, spaceId).map(projectGitHubWatchedRepo),
      },
    };
    persistSpaceExtensionConfig(db, spaceId, 'github', config, now);
    return { config };
  },
});
