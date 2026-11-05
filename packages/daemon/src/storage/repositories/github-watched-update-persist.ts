import type { Database } from '../sqlite-compat.ts';
import type {
  GitHubEventExtensionRepository,
  GitHubWatchedRepo,
} from '../../lib/external-events/github/github-repository.ts';
type Params = Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];

export function persistGitHubWatchedRepoUpdate(
  db: Database,
  params: Params,
  existing: GitHubWatchedRepo,
  now: number
): void {
  db.prepare(
    `UPDATE space_github_watched_repos
						 SET enabled = ?, webhook_enabled = ?, polling_enabled = ?, webhook_secret = COALESCE(?, webhook_secret),
						     webhook_remote_id = COALESCE(?, webhook_remote_id), webhook_url = COALESCE(?, webhook_url),
						     webhook_auto_registered = ?, webhook_active = ?, webhook_last_checked_at = COALESCE(?, webhook_last_checked_at),
						     webhook_last_error = ?, webhook_configured_at = COALESCE(?, webhook_configured_at), updated_at = ?
						 WHERE id = ?`
  ).run(
    params.enabled === undefined ? (existing.enabled ? 1 : 0) : params.enabled ? 1 : 0,
    params.webhookEnabled === undefined
      ? existing.webhookEnabled
        ? 1
        : 0
      : params.webhookEnabled
        ? 1
        : 0,
    params.pollingEnabled === undefined
      ? existing.pollingEnabled
        ? 1
        : 0
      : params.pollingEnabled
        ? 1
        : 0,
    params.webhookSecret ?? null,
    params.webhookRemoteId ?? null,
    params.webhookUrl ?? null,
    params.webhookAutoRegistered === undefined
      ? existing.webhookAutoRegistered
        ? 1
        : 0
      : params.webhookAutoRegistered
        ? 1
        : 0,
    params.webhookActive === undefined
      ? existing.webhookActive === null
        ? null
        : existing.webhookActive
          ? 1
          : 0
      : params.webhookActive === null
        ? null
        : params.webhookActive
          ? 1
          : 0,
    params.webhookLastCheckedAt ?? null,
    params.webhookLastError === undefined ? existing.webhookLastError : params.webhookLastError,
    params.webhookConfiguredAt ?? null,
    now,
    existing.id
  );
}
