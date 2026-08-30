import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import { generateUUID } from '@hyperneo/shared';

export interface PollCursor {
  lastSeenAt?: number;
  pendingLastSeenAt?: number;
  etags?: Record<string, string>;
  processedPages?: Record<string, number>;
  recentPullRequestNumbers?: number[];
  recentPullRequestHeadShas?: Record<number, string>;
  recentPullRequestHeadRepos?: Record<number, string>;
  checkRunEtags?: Record<string, string>;
  checkRunLegacyPrs?: Record<string, number>;
  checkRunPollingEnabledAt?: number;
  checkRunHeadLastSeenAt?: Record<string, number>;
  checkRunHeadPendingLastSeenAt?: Record<string, number>;
  pullsSeedInProgress?: boolean;
  seenReactionIds?: Record<string, boolean>;
  reactionEtags?: Record<number, string>;
  mergeConflictStates?: Record<number, boolean>;
  mergeConflictSequences?: Record<number, number>;
  mergeConflictEtags?: Record<number, string>;
  seenReviewIds?: Record<string, boolean>;
  reviewEtags?: Record<number, string>;
  reviewLastSeenAt?: Record<number, number>;
  endpointLastSeenAt?: Record<string, number>;
  endpointPendingLastSeenAt?: Record<string, number>;
  lastPollError?: string | null;
  lastPartialPollError?: string | null;
  lastReactionPollAt?: number | null;
  lastPollCredentialFingerprint?: string;
}

export interface GitHubWatchedRepo {
  id: string;
  spaceId: string;
  owner: string;
  repo: string;
  enabled: boolean;
  webhookEnabled: boolean;
  pollingEnabled: boolean;
  webhookSecret: string | null;
  webhookRemoteId: number | null;
  webhookUrl: string | null;
  webhookAutoRegistered: boolean;
  webhookActive: boolean | null;
  webhookLastCheckedAt: number | null;
  webhookLastError: string | null;
  webhookConfiguredAt: number | null;
  lastWebhookAt: number | null;
  lastPollAt: number | null;
  pollCursor: PollCursor | null;
  createdAt: number;
  updatedAt: number;
}

export class GitHubEventExtensionRepository {
  constructor(private readonly db: BunDatabase) {
    this.db.exec(`
			CREATE TABLE IF NOT EXISTS space_github_source_settings (
				space_id TEXT PRIMARY KEY,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
    const columns = this.db
      .prepare('PRAGMA table_info(space_github_source_settings)')
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'polling_intent')) {
      this.db.exec(
        'ALTER TABLE space_github_source_settings ADD COLUMN polling_intent INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!columns.some((column) => column.name === 'filter_current_user')) {
      this.db.exec(
        'ALTER TABLE space_github_source_settings ADD COLUMN filter_current_user INTEGER NOT NULL DEFAULT 1'
      );
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_github_source_settings (space_id, enabled, polling_intent, created_at, updated_at)
         SELECT DISTINCT s.space_id, 1, 1, ?, ?
         FROM space_github_watched_repos s
         JOIN spaces sp ON sp.id = s.space_id
         WHERE s.polling_enabled = 1
         ON CONFLICT(space_id) DO UPDATE SET
           polling_intent = excluded.polling_intent,
           updated_at = excluded.updated_at
         WHERE polling_intent = 0`
      )
      .run(now, now);
  }

  upsertWatchedRepo(params: {
    spaceId: string;
    owner: string;
    repo: string;
    enabled?: boolean;
    webhookEnabled?: boolean;
    pollingEnabled?: boolean;
    webhookSecret?: string | null;
    webhookRemoteId?: number | null;
    webhookUrl?: string | null;
    webhookAutoRegistered?: boolean;
    webhookActive?: boolean | null;
    webhookLastCheckedAt?: number | null;
    webhookLastError?: string | null;
    webhookConfiguredAt?: number | null;
  }): GitHubWatchedRepo {
    const now = Date.now();
    const existing = this.getWatchedRepo(params.spaceId, params.owner, params.repo);
    const wasActive = existing?.enabled && existing?.pollingEnabled;
    const nextEnabled = params.enabled === undefined ? (existing?.enabled ?? true) : params.enabled;
    const nextPolling = params.pollingEnabled ?? existing?.pollingEnabled ?? false;
    const willBeActive = nextEnabled && nextPolling;
    const pollingNewlyEnabled = willBeActive && !wasActive;
    if (existing) {
      this.db
        .prepare(
          `UPDATE space_github_watched_repos
						 SET enabled = ?, webhook_enabled = ?, polling_enabled = ?, webhook_secret = COALESCE(?, webhook_secret),
						     webhook_remote_id = COALESCE(?, webhook_remote_id), webhook_url = COALESCE(?, webhook_url),
						     webhook_auto_registered = ?, webhook_active = ?, webhook_last_checked_at = COALESCE(?, webhook_last_checked_at),
						     webhook_last_error = ?, webhook_configured_at = COALESCE(?, webhook_configured_at), updated_at = ?
						 WHERE id = ?`
        )
        .run(
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
          params.webhookLastError === undefined
            ? existing.webhookLastError
            : params.webhookLastError,
          params.webhookConfiguredAt ?? null,
          now,
          existing.id
        );
    } else {
      const id = generateUUID();
      const spaceEnabled = params.enabled ?? this.isSpaceEnabled(params.spaceId);
      this.db
        .prepare(
          `INSERT INTO space_github_watched_repos
					 (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret, webhook_remote_id, webhook_url,
					  webhook_auto_registered, webhook_active, webhook_last_checked_at, webhook_last_error, webhook_configured_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
    const watched = this.getWatchedRepo(params.spaceId, params.owner, params.repo)!;
    if (pollingNewlyEnabled) {
      const cursor = watched.pollCursor ?? {};
      cursor.checkRunPollingEnabledAt = now;
      delete cursor.checkRunHeadLastSeenAt;
      delete cursor.checkRunHeadPendingLastSeenAt;
      delete cursor.endpointLastSeenAt?.check_runs;
      delete cursor.endpointPendingLastSeenAt?.check_runs;
      this.updatePollCursorJson(watched.id, cursor);
    }
    return this.getWatchedRepoById(watched.id)!;
  }

  clearWebhookRegistration(id: string, options: { clearSecret?: boolean } = {}): void {
    this.db
      .prepare(
        `UPDATE space_github_watched_repos
         SET webhook_secret = CASE WHEN ? THEN NULL ELSE webhook_secret END,
             webhook_remote_id = NULL, webhook_url = NULL, webhook_auto_registered = 0, webhook_active = NULL,
             webhook_last_checked_at = NULL, webhook_last_error = NULL, webhook_configured_at = NULL,
             last_webhook_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(options.clearSecret ? 1 : 0, Date.now(), id);
  }

  setRepoEnabled(spaceId: string, enabled: boolean): number {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_github_source_settings (space_id, enabled, created_at, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(spaceId, enabled ? 1 : 0, now, now);
    return this.db
      .prepare(
        `UPDATE space_github_watched_repos SET enabled = ?, updated_at = ? WHERE space_id = ?`
      )
      .run(enabled ? 1 : 0, now, spaceId).changes;
  }

  setPollingIntent(spaceId: string, enabled: boolean): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_github_source_settings (space_id, enabled, polling_intent, created_at, updated_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET polling_intent = excluded.polling_intent, updated_at = excluded.updated_at`
      )
      .run(spaceId, enabled ? 1 : 0, now, now);
  }

  getPollingIntent(spaceId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT polling_intent AS pollingIntent FROM space_github_source_settings WHERE space_id = ?'
      )
      .get(spaceId) as { pollingIntent: number } | undefined;
    return row ? row.pollingIntent === 1 : false;
  }

  setFilterCurrentUser(spaceId: string, enabled: boolean): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_github_source_settings (space_id, enabled, filter_current_user, created_at, updated_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(space_id) DO UPDATE SET filter_current_user = excluded.filter_current_user, updated_at = excluded.updated_at`
      )
      .run(spaceId, enabled ? 1 : 0, now, now);
  }

  getFilterCurrentUser(spaceId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT filter_current_user AS filterCurrentUser FROM space_github_source_settings WHERE space_id = ?'
      )
      .get(spaceId) as { filterCurrentUser: number } | undefined;
    return row ? row.filterCurrentUser === 1 : true;
  }

  countSpacesWithPollingIntent(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM space_github_source_settings s
         JOIN spaces sp ON sp.id = s.space_id
         WHERE s.polling_intent = 1`
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  countAllAutoRegisteredHookRefs(): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM space_github_watched_repos WHERE webhook_auto_registered = 1 AND webhook_remote_id IS NOT NULL'
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  removeWatchedRepo(spaceId: string, owner: string, repo: string): boolean {
    return (
      this.db
        .prepare(
          `DELETE FROM space_github_watched_repos WHERE space_id = ? AND lower(owner)=lower(?) AND lower(repo)=lower(?)`
        )
        .run(spaceId, owner, repo).changes > 0
    );
  }

  isSpaceEnabled(spaceId: string): boolean {
    const row = this.db
      .prepare(`SELECT enabled FROM space_github_source_settings WHERE space_id = ?`)
      .get(spaceId) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : true;
  }

  listWatchedRepos(spaceId?: string): GitHubWatchedRepo[] {
    const rows = spaceId
      ? (this.db
          .prepare(
            `SELECT * FROM space_github_watched_repos WHERE space_id = ? ORDER BY owner, repo`
          )
          .all(spaceId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM space_github_watched_repos ORDER BY space_id, owner, repo`)
          .all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToRepo(r));
  }

  listWebhookValidationRepos(): GitHubWatchedRepo[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM space_github_watched_repos WHERE webhook_enabled = 1 AND webhook_secret IS NOT NULL`
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToRepo(r));
  }

  listPollingRepos(spaceId?: string): GitHubWatchedRepo[] {
    const rows = spaceId
      ? (this.db
          .prepare(
            `SELECT * FROM space_github_watched_repos WHERE space_id = ? AND enabled = 1 AND polling_enabled = 1 ORDER BY owner, repo`
          )
          .all(spaceId) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT * FROM space_github_watched_repos WHERE enabled = 1 AND polling_enabled = 1 ORDER BY space_id, owner, repo`
          )
          .all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToRepo(r));
  }

  listAllPollingConfiguredRepos(spaceId?: string): GitHubWatchedRepo[] {
    const rows = spaceId
      ? (this.db
          .prepare(
            `SELECT r.* FROM space_github_watched_repos r
             JOIN spaces sp ON sp.id = r.space_id
             WHERE r.space_id = ? AND r.polling_enabled = 1
             ORDER BY r.owner, r.repo`
          )
          .all(spaceId) as Record<string, unknown>[])
      : (this.db
          .prepare(
            `SELECT r.* FROM space_github_watched_repos r
             JOIN spaces sp ON sp.id = r.space_id
             WHERE r.polling_enabled = 1
             ORDER BY r.space_id, r.owner, r.repo`
          )
          .all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToRepo(r));
  }

  getWatchedRepo(spaceId: string, owner: string, repo: string): GitHubWatchedRepo | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_github_watched_repos WHERE space_id = ? AND lower(owner)=lower(?) AND lower(repo)=lower(?)`
      )
      .get(spaceId, owner, repo) as Record<string, unknown> | undefined;
    return row ? this.rowToRepo(row) : null;
  }

  getAutoRegisteredRepo(owner: string, repo: string, webhookUrl: string): GitHubWatchedRepo | null {
    const row = this.db
      .prepare(
        `SELECT * FROM space_github_watched_repos
         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
           AND webhook_remote_id IS NOT NULL AND webhook_secret IS NOT NULL AND webhook_url = ?
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(owner, repo, webhookUrl) as Record<string, unknown> | undefined;
    return row ? this.rowToRepo(row) : null;
  }

  countAutoRegisteredHookRefs(owner: string, repo: string, webhookRemoteId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM space_github_watched_repos
         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
           AND webhook_remote_id = ?`
      )
      .get(owner, repo, webhookRemoteId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  updateSharedAutoHook(params: {
    owner: string;
    repo: string;
    previousWebhookRemoteId: number;
    webhookRemoteId: number;
    webhookSecret: string;
    webhookUrl: string;
    webhookActive: boolean | null;
    webhookLastCheckedAt: number;
    webhookConfiguredAt: number;
  }): void {
    this.db
      .prepare(
        `UPDATE space_github_watched_repos
         SET webhook_remote_id = ?, webhook_secret = ?, webhook_url = ?, webhook_active = ?, webhook_last_checked_at = ?,
             webhook_last_error = NULL, webhook_configured_at = ?, updated_at = ?
         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
           AND webhook_remote_id = ?`
      )
      .run(
        params.webhookRemoteId,
        params.webhookSecret,
        params.webhookUrl,
        params.webhookActive === null ? null : params.webhookActive ? 1 : 0,
        params.webhookLastCheckedAt,
        params.webhookConfiguredAt,
        Date.now(),
        params.owner,
        params.repo,
        params.previousWebhookRemoteId
      );
  }

  updateSharedWebhookStatus(
    owner: string,
    repo: string,
    webhookRemoteId: number,
    status: {
      active?: boolean | null;
      lastCheckedAt?: number | null;
      lastError?: string | null;
    }
  ): void {
    const rows = this.db
      .prepare(
        `SELECT id FROM space_github_watched_repos
         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
           AND webhook_remote_id = ?`
      )
      .all(owner, repo, webhookRemoteId) as { id: string }[];
    for (const row of rows) {
      this.updateWebhookStatus(row.id, status);
    }
  }

  getWatchedRepoById(id: string): GitHubWatchedRepo | null {
    const row = this.db.prepare(`SELECT * FROM space_github_watched_repos WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRepo(row) : null;
  }

  markWebhookReceived(id: string): void {
    this.db
      .prepare(
        `UPDATE space_github_watched_repos
         SET last_webhook_at = ?,
             webhook_last_error = CASE
               WHEN webhook_active = 0 THEN webhook_last_error
               ELSE NULL
             END,
             updated_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), Date.now(), id);
  }

  clearWebhookDeliveryHistory(id: string): void {
    this.db
      .prepare(
        `UPDATE space_github_watched_repos SET last_webhook_at = NULL, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), id);
  }

  updatePollCursor(id: string, cursor: PollCursor): void {
    this.db
      .prepare(
        `UPDATE space_github_watched_repos SET last_poll_at = ?, poll_cursor = ?, updated_at = ? WHERE id = ?`
      )
      .run(Date.now(), JSON.stringify(cursor), Date.now(), id);
  }

  updatePollCursorJson(id: string, cursor: PollCursor): void {
    this.db
      .prepare(`UPDATE space_github_watched_repos SET poll_cursor = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(cursor), Date.now(), id);
  }

  clearPollErrorsForAllRepos(): void {
    for (const repo of this.listWatchedRepos()) {
      if (!repo.pollCursor?.lastPollError && !repo.pollCursor?.lastPartialPollError) continue;
      this.updatePollCursorJson(repo.id, {
        ...repo.pollCursor,
        lastPollError: null,
        lastPartialPollError: null,
      });
    }
  }

  recordPollFailure(id: string, error: string, accessible = false): void {
    const existing = this.getWatchedRepoById(id);
    if (!existing) return;
    this.updatePollCursorJson(id, {
      ...existing.pollCursor,
      ...(accessible
        ? {
            lastPartialPollError: error,
            lastPollError: null,
          }
        : {
            lastPollError: error,
            lastPartialPollError: null,
          }),
    });
  }

  updateWebhookStatus(
    id: string,
    status: {
      active?: boolean | null;
      lastCheckedAt?: number | null;
      lastError?: string | null;
    }
  ): void {
    const existing = this.getWatchedRepoById(id);
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE space_github_watched_repos
         SET webhook_active = ?, webhook_last_checked_at = ?, webhook_last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        status.active === undefined
          ? existing.webhookActive === null
            ? null
            : existing.webhookActive
              ? 1
              : 0
          : status.active === null
            ? null
            : status.active
              ? 1
              : 0,
        status.lastCheckedAt ?? existing.webhookLastCheckedAt,
        status.lastError === undefined ? existing.webhookLastError : status.lastError,
        Date.now(),
        id
      );
  }

  private rowToRepo(row: Record<string, unknown>): GitHubWatchedRepo {
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
}
