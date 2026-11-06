import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { GitHubWatchedRepo } from '../../lib/external-events/github/github-repository.ts';
import type { SpaceExternalEventSourceConfig } from '../../lib/external-events/types.ts';
import { listGitHubPollingConfiguredRepos } from './github-polling-repos-read.ts';
import { persistGitHubPollingIntent } from './github-polling-intent-persist.ts';
import { readPollingSnapshot } from './github-polling-enabled-write.ts';

type Input = { spaceId: string; pollingEnabled: boolean; wasPolling: boolean };
function selectWatchPollingIntent(input: Input, configured: GitHubWatchedRepo[]) {
  if (input.pollingEnabled) return true;
  if (input.wasPolling && configured.length === 0) return false;
}
function persistWatchPollingIntent(db: Database, spaceId: string, enabled: boolean | undefined) {
  if (enabled !== undefined) persistGitHubPollingIntent(db, spaceId, enabled, Date.now());
}
const commitWatchPollingIntent = (superpipe({})('github-watch-polling-commit') as PipelineAPI)
  .input(['db', 'input'])
  .pipe((input: Input) => input.spaceId, 'input', 'spaceId')
  .pipe(listGitHubPollingConfiguredRepos, ['db', 'spaceId'], 'configured')
  .pipe(selectWatchPollingIntent, ['input', 'configured'], 'intent')
  .pipe(persistWatchPollingIntent, ['db', 'spaceId', 'intent'])
  .pipe(readPollingSnapshot, ['db', 'spaceId'], 'config')
  .end('config') as (db: Database, input: Input) => SpaceExternalEventSourceConfig;

export const gitHubWatchPollingWrite = defineDbOp({
  name: 'github.watched.polling.write',
  mode: 'write',
  run: commitWatchPollingIntent,
});
