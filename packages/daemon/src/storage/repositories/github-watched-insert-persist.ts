import type { Database } from '../sqlite-compat.ts';
import type { GitHubEventExtensionRepository } from '../../lib/external-events/github/github-repository.ts';
import { schemaTableExists } from '../schema/extensions.ts';
import { GITHUB_SPACE_WATCHED_TABLE, requireGitHubScopeTable } from './github-scope.ts';
type Params = Parameters<GitHubEventExtensionRepository['upsertWatchedRepo']>[0];

export function persistGitHubWatchedRepoInsert(
  db: Database,
  params: Params,
  id: string,
  spaceEnabled: boolean,
  now: number
): void {
  const table = requireGitHubScopeTable(db, params.spaceId);
  const legacyMirror =
    params.spaceId === 'sessions' && schemaTableExists(db, GITHUB_SPACE_WATCHED_TABLE);
  const targets = legacyMirror ? [GITHUB_SPACE_WATCHED_TABLE, table] : [table];
  for (const target of targets) {
    db.prepare(
      `INSERT ${target === table ? 'INTO' : 'OR IGNORE INTO'} ${target}
					 (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret, webhook_remote_id, webhook_url,
					  webhook_auto_registered, webhook_active, webhook_last_checked_at, webhook_last_error, webhook_configured_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.spaceId,
      params.owner,
      params.repo,
      spaceEnabled ? 1 : 0,
      params.webhookEnabled === false ? 0 : 1,
      params.pollingEnabled ? 1 : 0,
      params.webhookSecret ?? null,
      params.webhookRemoteId ?? null,
      params.webhookUrl ?? null,
      params.webhookAutoRegistered ? 1 : 0,
      params.webhookActive === undefined || params.webhookActive === null
        ? null
        : params.webhookActive
          ? 1
          : 0,
      params.webhookLastCheckedAt ?? null,
      params.webhookLastError ?? null,
      params.webhookConfiguredAt ?? null,
      now,
      now
    );
  }
}
