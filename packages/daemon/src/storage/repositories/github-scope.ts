import type { Database } from '../sqlite-compat.ts';
import { schemaTableExists } from '../schema/extensions.ts';

export const GITHUB_SESSION_SCOPE = 'sessions';
export const GITHUB_SESSION_WATCHED_TABLE = 'github_session_watched_repos';
export const GITHUB_SESSION_SETTINGS_TABLE = 'github_session_source_settings';
export const GITHUB_SPACE_WATCHED_TABLE = 'space_github_watched_repos';
export const GITHUB_SPACE_SETTINGS_TABLE = 'space_github_source_settings';

export function gitHubWatchedTableForScope(spaceId: string): string {
  return spaceId === GITHUB_SESSION_SCOPE
    ? GITHUB_SESSION_WATCHED_TABLE
    : GITHUB_SPACE_WATCHED_TABLE;
}

export function gitHubSettingsTableForScope(spaceId: string): string {
  return spaceId === GITHUB_SESSION_SCOPE
    ? GITHUB_SESSION_SETTINGS_TABLE
    : GITHUB_SPACE_SETTINGS_TABLE;
}

export function requireGitHubScopeTable(db: Database, spaceId: string): string {
  const table = gitHubWatchedTableForScope(spaceId);
  if (!schemaTableExists(db, table)) {
    throw new Error(`GitHub storage table ${table} is not initialized for scope "${spaceId}"`);
  }
  return table;
}

export function requireGitHubScopeSettingsTable(db: Database, spaceId: string): string {
  const table = gitHubSettingsTableForScope(spaceId);
  if (!schemaTableExists(db, table)) {
    throw new Error(`GitHub storage table ${table} is not initialized for scope "${spaceId}"`);
  }
  return table;
}

export function gitHubWatchedTableForId(db: Database, id: string): string | null {
  if (
    schemaTableExists(db, GITHUB_SESSION_WATCHED_TABLE) &&
    db.prepare(`SELECT 1 FROM ${GITHUB_SESSION_WATCHED_TABLE} WHERE id = ? LIMIT 1`).get(id)
  ) {
    return GITHUB_SESSION_WATCHED_TABLE;
  }
  if (
    schemaTableExists(db, GITHUB_SPACE_WATCHED_TABLE) &&
    db
      .prepare(
        `SELECT 1 FROM ${GITHUB_SPACE_WATCHED_TABLE} WHERE id = ? AND space_id != '${GITHUB_SESSION_SCOPE}' LIMIT 1`
      )
      .get(id)
  ) {
    return GITHUB_SPACE_WATCHED_TABLE;
  }
  return null;
}

const WATCHED_UNION_COLUMNS =
  `id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret, ` +
  `webhook_remote_id, webhook_url, webhook_auto_registered, webhook_active, ` +
  `webhook_last_checked_at, webhook_last_error, webhook_configured_at, last_webhook_at, ` +
  `last_poll_at, poll_cursor, created_at, updated_at`;

const EMPTY_WATCHED_SOURCE =
  `(SELECT NULL AS id, NULL AS space_id, NULL AS owner, NULL AS repo, NULL AS enabled, ` +
  `NULL AS webhook_enabled, NULL AS polling_enabled, NULL AS webhook_secret, ` +
  `NULL AS webhook_remote_id, NULL AS webhook_url, NULL AS webhook_auto_registered, ` +
  `NULL AS webhook_active, NULL AS webhook_last_checked_at, NULL AS webhook_last_error, ` +
  `NULL AS webhook_configured_at, NULL AS last_webhook_at, NULL AS last_poll_at, ` +
  `NULL AS poll_cursor, NULL AS created_at, NULL AS updated_at WHERE 0)`;

export function gitHubWatchedSource(db: Database): string {
  const parts: string[] = [];
  if (schemaTableExists(db, GITHUB_SESSION_WATCHED_TABLE)) {
    parts.push(`SELECT ${WATCHED_UNION_COLUMNS} FROM ${GITHUB_SESSION_WATCHED_TABLE}`);
  }
  if (schemaTableExists(db, GITHUB_SPACE_WATCHED_TABLE)) {
    parts.push(
      `SELECT ${WATCHED_UNION_COLUMNS} FROM ${GITHUB_SPACE_WATCHED_TABLE} WHERE space_id != '${GITHUB_SESSION_SCOPE}'`
    );
  }
  if (parts.length === 0) return EMPTY_WATCHED_SOURCE;
  return `(${parts.join(' UNION ALL ')})`;
}

export function selectGitHubWatchedRows(
  db: Database,
  spaceId: string | undefined,
  filter: string | null = null
): Record<string, unknown>[] {
  const extra = filter ? ` AND ${filter}` : '';
  if (spaceId) {
    const table = gitHubWatchedTableForScope(spaceId);
    if (!schemaTableExists(db, table)) return [];
    return db
      .prepare(`SELECT * FROM ${table} WHERE space_id = ?${extra} ORDER BY owner, repo`)
      .all(spaceId) as Record<string, unknown>[];
  }
  const where = filter ? `WHERE ${filter}` : '';
  return db
    .prepare(`SELECT * FROM ${gitHubWatchedSource(db)} ${where} ORDER BY space_id, owner, repo`)
    .all() as Record<string, unknown>[];
}

export function selectGitHubSpaceJoinedPollingRows(
  db: Database,
  spaceId: string | undefined
): Record<string, unknown>[] {
  if (!schemaTableExists(db, 'spaces') || !schemaTableExists(db, GITHUB_SPACE_WATCHED_TABLE)) {
    return [];
  }
  const where = spaceId ? `r.space_id = ? AND r.polling_enabled = 1` : `r.polling_enabled = 1`;
  const order = spaceId ? `r.owner, r.repo` : `r.space_id, r.owner, r.repo`;
  const params = spaceId ? [spaceId] : [];
  return db
    .prepare(
      `SELECT r.* FROM ${GITHUB_SPACE_WATCHED_TABLE} r
         JOIN spaces sp ON sp.id = r.space_id
         WHERE ${where}
         ORDER BY ${order}`
    )
    .all(...params) as Record<string, unknown>[];
}

export function countGitHubPollingIntentRows(db: Database): number {
  let count = 0;
  if (schemaTableExists(db, 'spaces') && schemaTableExists(db, GITHUB_SPACE_SETTINGS_TABLE)) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${GITHUB_SPACE_SETTINGS_TABLE} s
         JOIN spaces sp ON sp.id = s.space_id
         WHERE s.polling_intent = 1`
      )
      .get() as { count: number } | undefined;
    count += row?.count ?? 0;
  }
  if (schemaTableExists(db, GITHUB_SESSION_SETTINGS_TABLE)) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${GITHUB_SESSION_SETTINGS_TABLE} WHERE polling_intent = 1`
      )
      .get() as { count: number } | undefined;
    count += row?.count ?? 0;
  }
  return count;
}
