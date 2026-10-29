import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { GitHubWatchedRepo } from '../../lib/external-events/github/github-repository.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';
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

type Input = { spaceId: string; enabled: boolean };
type Receipt = { config: SpaceExternalEventSourceConfig };
export function requirePollingSpace(spaceId: string): string {
  if (!spaceId || spaceId.trim().length === 0 || spaceId !== spaceId.trim()) {
    throw new Error('Space id must be non-empty and must not include edge whitespace');
  }
  return spaceId;
}
export function selectPollingTargets(repos: GitHubWatchedRepo[], enabled: boolean) {
  return repos.filter((repo) => !(enabled && repo.webhookEnabled && repo.webhookSecret));
}
function persistPollingTargets(db: Database, targets: GitHubWatchedRepo[], enabled: boolean) {
  for (const { spaceId, owner, repo } of targets) {
    upsertGitHubWatchedRepo(db, { spaceId, owner, repo, pollingEnabled: enabled });
  }
}
function readPollingSnapshot(db: Database, spaceId: string): SpaceExternalEventSourceConfig {
  return {
    spaceId,
    source: 'github',
    enabled: readGitHubSpaceEnabled(db, spaceId),
    settings: {
      pollingIntent: readGitHubPollingIntent(db, spaceId),
      filterCurrentUser: readGitHubFilterCurrentUser(db, spaceId),
      watchedRepos: listGitHubWatchedRepos(db, spaceId).map(projectGitHubWatchedRepo),
    },
  };
}
const commitPollingPreference = (superpipe({})('github-space-polling-commit') as PipelineAPI)
  .input(['db', 'spaceId', 'enabled'])
  .pipe(requirePollingSpace, 'spaceId', 'admittedSpace')
  .pipe(listGitHubWatchedRepos, ['db', 'admittedSpace'], 'watched')
  .pipe(selectPollingTargets, ['watched', 'enabled'], 'targets')
  .pipe(persistPollingTargets, ['db', 'targets', 'enabled'])
  .pipe(() => Date.now(), undefined, 'now')
  .pipe(persistGitHubPollingIntent, ['db', 'admittedSpace', 'enabled', 'now'])
  .pipe(readPollingSnapshot, ['db', 'admittedSpace'], 'config')
  .pipe(
    (db: Database, spaceId: string, config: SpaceExternalEventSourceConfig, now: number) =>
      persistSpaceExtensionConfig(db, spaceId, 'github', config, now),
    ['db', 'admittedSpace', 'config', 'now']
  )
  .pipe((config: SpaceExternalEventSourceConfig) => ({ config }), 'config', 'receipt')
  .end('receipt') as (db: Database, spaceId: string, enabled: boolean) => Receipt;

export const gitHubPollingWrites = defineDbOp({
  name: 'github.space.polling.write',
  mode: 'write',
  run: (db: Database, input: Input) => commitPollingPreference(db, input.spaceId, input.enabled),
});
