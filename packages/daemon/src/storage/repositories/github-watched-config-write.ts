import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type {
  GitHubEventExtensionRepository,
  GitHubWatchedRepo,
} from '../../lib/external-events/github/github-repository.ts';
import { upsertGitHubWatchedRepo } from './github-watched-upsert-persist.ts';
import { findGitHubWatchedRepoById } from './github-watched-repo-lookups.ts';
import {
  clearGitHubWebhookRegistration,
  clearGitHubWebhookDeliveryHistory,
} from './github-webhook-clear-persist.ts';

type Input = {
  params: Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];
  clearRegistration: boolean;
  clearSecret: boolean;
  clearDelivery: boolean;
};
function clearWatchedWebhook(db: Database, watched: GitHubWatchedRepo, input: Input) {
  if (input.clearRegistration) clearGitHubWebhookRegistration(db, watched.id, input.clearSecret);
  if (input.clearDelivery) clearGitHubWebhookDeliveryHistory(db, watched.id);
}
const commitWatchedConfig = (superpipe({})('github-watched-config-commit') as PipelineAPI)
  .input(['db', 'input'])
  .pipe((input: Input) => input.params, 'input', 'params')
  .pipe(upsertGitHubWatchedRepo, ['db', 'params'], 'watched')
  .pipe(clearWatchedWebhook, ['db', 'watched', 'input'])
  .pipe(
    (db: Database, watched: GitHubWatchedRepo) =>
      findGitHubWatchedRepoById(db, watched.id) ?? watched,
    ['db', 'watched'],
    'receipt'
  )
  .end('receipt') as (db: Database, input: Input) => GitHubWatchedRepo;

export const gitHubWatchedConfigWrite = defineDbOp({
  name: 'github.watched.config.write',
  mode: 'write',
  run: commitWatchedConfig,
});
