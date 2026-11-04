import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import {
  countGitHubSpacesWithPollingIntent,
  listGitHubPollingRepos,
  listGitHubPollingConfiguredRepos,
} from './github-polling-repos-read.ts';

export function hasPollingRows(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}
export function hasPollingIntent(count: number): boolean {
  return count > 0;
}
export function continueWhileUnused(inUse: boolean): { value: false } | { reason: true } {
  return inUse ? { reason: true } : { value: false };
}
const readCapabilityUsage = (superpipe({})('github-polling-capability-usage') as PipelineAPI)
  .input(['db', 'sessionScope'])
  .pipe(listGitHubPollingConfiguredRepos, 'db', 'configured')
  .pipe(hasPollingRows, 'configured', 'inUse')
  .pipe(continueWhileUnused, 'inUse', 'result:inUse')
  .pipe(countGitHubSpacesWithPollingIntent, 'db', 'intentCount')
  .pipe(hasPollingIntent, 'intentCount', 'inUse')
  .pipe(continueWhileUnused, 'inUse', 'result:inUse')
  .pipe(listGitHubPollingRepos, ['db', 'sessionScope'], 'sessionRows')
  .pipe(hasPollingRows, 'sessionRows', 'inUse')
  .end('inUse') as (db: Database, sessionScope: string) => boolean;

const readTimerUsage = (superpipe({})('github-polling-timer-usage') as PipelineAPI)
  .input('db')
  .pipe(listGitHubPollingRepos, 'db', 'activeRows')
  .pipe(hasPollingRows, 'activeRows', 'inUse')
  .end('inUse') as (db: Database) => boolean;

export const gitHubPollingCapabilityReads = defineDbOp({
  name: 'github.polling.capability.read',
  mode: 'read',
  run: (db: Database, input: { sessionScope: string }) =>
    readCapabilityUsage(db, input.sessionScope),
});
export const gitHubPollingTimerReads = defineDbOp({
  name: 'github.polling.timer.read',
  mode: 'read',
  run: (db: Database, _input: Record<string, never>) => readTimerUsage(db),
});
