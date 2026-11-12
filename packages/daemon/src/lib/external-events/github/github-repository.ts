import {
  countGitHubSpacesWithPollingIntent,
  listGitHubPollingRepos,
  listGitHubPollingConfiguredRepos,
} from '../../../storage/repositories/github-polling-repos-read.ts';
import { upsertGitHubWatchedRepo } from '../../../storage/repositories/github-watched-upsert-persist.ts';
import { persistGitHubPollCursorJson } from '../../../storage/repositories/github-cursor-persist.ts';
import {
  findGitHubWatchedRepo,
  findGitHubWatchedRepoById,
} from '../../../storage/repositories/github-watched-repo-lookups.ts';
import { persistGitHubPollingIntent } from '../../../storage/repositories/github-polling-intent-persist.ts';
import { persistGitHubFilterCurrentUser } from '../../../storage/repositories/github-filter-persist.ts';
import {
  listGitHubWatchedRepos,
  mapGitHubWatchedRepo,
} from '../../../storage/repositories/github-watched-repos-read.ts';
import {
  readGitHubSpaceEnabled,
  readGitHubPollingIntent,
  readGitHubFilterCurrentUser,
} from '../../../storage/repositories/github-space-settings-read.ts';
import { persistGitHubSpaceEnabled } from '../../../storage/repositories/github-space-enabled-persist.ts';
import {
  GITHUB_SESSION_SCOPE,
  GITHUB_SESSION_WATCHED_TABLE,
  GITHUB_SPACE_WATCHED_TABLE,
  gitHubWatchedSource,
  gitHubWatchedTableForId,
  gitHubWatchedTableForScope,
} from '../../../storage/repositories/github-scope.ts';
import { schemaTableExists } from '../../../storage/schema/extensions.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { GitHubPollResume } from './github-poll-slice.ts';

export interface PollCursor {
  pollResume?: GitHubPollResume;
  lastSeenAt?: number;
  pendingLastSeenAt?: number;
  etags?: Record<string, string>;
  processedPages?: Record<string, number>;
  recentPullRequestNumbers?: number[];
  recentPullRequestHeadShas?: Record<number, string>;
  recentPullRequestHeadRepos?: Record<number, string>;
  subscribedPullRequestNumbers?: number[];
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
  selfLogin?: { login: string; fingerprint: string };
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
  constructor(private readonly db: BunDatabase) {}

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
    return upsertGitHubWatchedRepo(this.db, params);
  }

  setRepoEnabled(spaceId: string, enabled: boolean): number {
    const now = Date.now();
    return persistGitHubSpaceEnabled(this.db, spaceId, enabled, now);
  }

  setPollingIntent(spaceId: string, enabled: boolean): void {
    const now = Date.now();
    persistGitHubPollingIntent(this.db, spaceId, enabled, now);
  }

  getPollingIntent(spaceId: string): boolean {
    return readGitHubPollingIntent(this.db, spaceId);
  }

  setFilterCurrentUser(spaceId: string, enabled: boolean): void {
    const now = Date.now();
    persistGitHubFilterCurrentUser(this.db, spaceId, enabled, now);
  }

  getFilterCurrentUser(spaceId: string): boolean {
    return readGitHubFilterCurrentUser(this.db, spaceId);
  }

  countSpacesWithPollingIntent(): number {
    return countGitHubSpacesWithPollingIntent(this.db);
  }

  countAllAutoRegisteredHookRefs(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${gitHubWatchedSource(this.db)} WHERE webhook_auto_registered = 1 AND webhook_remote_id IS NOT NULL`
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  removeWatchedRepo(spaceId: string, owner: string, repo: string): boolean {
    const table = gitHubWatchedTableForScope(spaceId);
    if (!schemaTableExists(this.db, table)) return false;
    if (
      spaceId === GITHUB_SESSION_SCOPE &&
      schemaTableExists(this.db, GITHUB_SPACE_WATCHED_TABLE)
    ) {
      this.db
        .prepare(
          `DELETE FROM ${GITHUB_SPACE_WATCHED_TABLE} WHERE space_id = ? AND lower(owner)=lower(?) AND lower(repo)=lower(?)`
        )
        .run(spaceId, owner, repo);
    }
    return (
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE space_id = ? AND lower(owner)=lower(?) AND lower(repo)=lower(?)`
        )
        .run(spaceId, owner, repo).changes > 0
    );
  }

  isSpaceEnabled(spaceId: string): boolean {
    return readGitHubSpaceEnabled(this.db, spaceId);
  }

  listWatchedRepos(spaceId?: string): GitHubWatchedRepo[] {
    return listGitHubWatchedRepos(this.db, spaceId);
  }

  listWebhookValidationRepos(): GitHubWatchedRepo[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM ${gitHubWatchedSource(this.db)} WHERE webhook_enabled = 1 AND webhook_secret IS NOT NULL`
        )
        .all() as Record<string, unknown>[]
    ).map((r) => this.rowToRepo(r));
  }

  listPollingRepos(spaceId?: string): GitHubWatchedRepo[] {
    return listGitHubPollingRepos(this.db, spaceId);
  }

  listAllPollingConfiguredRepos(spaceId?: string): GitHubWatchedRepo[] {
    return listGitHubPollingConfiguredRepos(this.db, spaceId);
  }

  getWatchedRepo(spaceId: string, owner: string, repo: string): GitHubWatchedRepo | null {
    return findGitHubWatchedRepo(this.db, spaceId, owner, repo);
  }

  getAutoRegisteredRepo(owner: string, repo: string, webhookUrl: string): GitHubWatchedRepo | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${gitHubWatchedSource(this.db)}
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
        `SELECT COUNT(*) AS count FROM ${gitHubWatchedSource(this.db)}
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
    const tables: string[] = [];
    if (schemaTableExists(this.db, GITHUB_SESSION_WATCHED_TABLE))
      tables.push(GITHUB_SESSION_WATCHED_TABLE);
    if (schemaTableExists(this.db, GITHUB_SPACE_WATCHED_TABLE))
      tables.push(GITHUB_SPACE_WATCHED_TABLE);
    this.db.transaction(() => {
      for (const table of tables) {
        const excluded = table === GITHUB_SPACE_WATCHED_TABLE ? ` AND space_id != 'sessions'` : '';
        this.db
          .prepare(
            `UPDATE ${table}
	         SET webhook_remote_id = ?, webhook_secret = ?, webhook_url = ?, webhook_active = ?, webhook_last_checked_at = ?,
	             webhook_last_error = NULL, webhook_configured_at = ?, updated_at = ?
	         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
	           AND webhook_remote_id = ?${excluded}`
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
    })();
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
        `SELECT id FROM ${gitHubWatchedSource(this.db)}
         WHERE lower(owner)=lower(?) AND lower(repo)=lower(?) AND webhook_auto_registered = 1
           AND webhook_remote_id = ?`
      )
      .all(owner, repo, webhookRemoteId) as { id: string }[];
    for (const row of rows) {
      this.updateWebhookStatus(row.id, status);
    }
  }

  getWatchedRepoById(id: string): GitHubWatchedRepo | null {
    return findGitHubWatchedRepoById(this.db, id);
  }

  markWebhookReceived(id: string): void {
    const table = gitHubWatchedTableForId(this.db, id);
    if (!table) return;
    this.db
      .prepare(
        `UPDATE ${table}
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

  updatePollCursor(id: string, cursor: PollCursor): void {
    const table = gitHubWatchedTableForId(this.db, id);
    if (!table) return;
    this.db
      .prepare(`UPDATE ${table} SET last_poll_at = ?, poll_cursor = ?, updated_at = ? WHERE id = ?`)
      .run(Date.now(), JSON.stringify(cursor), Date.now(), id);
  }

  updatePollCursorJson(id: string, cursor: PollCursor): void {
    persistGitHubPollCursorJson(this.db, id, cursor);
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
    const table = gitHubWatchedTableForId(this.db, id);
    if (!table) return;
    this.db
      .prepare(
        `UPDATE ${table}
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
    return mapGitHubWatchedRepo(row);
  }
}
