import type { Database } from '../sqlite-compat.ts';
import type {
  GitHubWatchedRepo,
  PollCursor,
} from '../../lib/external-events/github/github-repository.ts';
import { selectGitHubWatchedRows } from './github-scope.ts';

export function mapGitHubWatchedRepo(row: Record<string, unknown>): GitHubWatchedRepo {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    owner: row.owner as string,
    repo: row.repo as string,
    enabled: row.enabled === 1,
    webhookEnabled: row.webhook_enabled === 1,
    pollingEnabled: row.polling_enabled === 1,
    webhookSecret: (row.webhook_secret as string | null) ?? null,
    webhookRemoteId: (row.webhook_remote_id as number | null) ?? null,
    webhookUrl: (row.webhook_url as string | null) ?? null,
    webhookAutoRegistered: row.webhook_auto_registered === 1,
    webhookActive:
      row.webhook_active === null || row.webhook_active === undefined
        ? null
        : row.webhook_active === 1,
    webhookLastCheckedAt: (row.webhook_last_checked_at as number | null) ?? null,
    webhookLastError: (row.webhook_last_error as string | null) ?? null,
    webhookConfiguredAt: (row.webhook_configured_at as number | null) ?? null,
    lastWebhookAt: (row.last_webhook_at as number | null) ?? null,
    lastPollAt: (row.last_poll_at as number | null) ?? null,
    pollCursor: row.poll_cursor ? (JSON.parse(row.poll_cursor as string) as PollCursor) : null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function listGitHubWatchedRepos(db: Database, spaceId?: string): GitHubWatchedRepo[] {
  return selectGitHubWatchedRows(db, spaceId).map(mapGitHubWatchedRepo);
}
