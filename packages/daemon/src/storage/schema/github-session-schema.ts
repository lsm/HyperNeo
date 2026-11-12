import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { schemaTableExists } from './extensions.ts';

const SESSION_SCOPE = 'sessions';
const LEGACY_WATCHED_TABLE = 'space_github_watched_repos';

export const GITHUB_SESSION_WATCHED_COLUMNS: Array<{ name: string; fallback: string }> = [
  { name: 'id', fallback: `''` },
  { name: 'space_id', fallback: `''` },
  { name: 'owner', fallback: `''` },
  { name: 'repo', fallback: `''` },
  { name: 'enabled', fallback: `1` },
  { name: 'webhook_enabled', fallback: `1` },
  { name: 'polling_enabled', fallback: `0` },
  { name: 'webhook_secret', fallback: `NULL` },
  { name: 'webhook_remote_id', fallback: `NULL` },
  { name: 'webhook_url', fallback: `NULL` },
  { name: 'webhook_auto_registered', fallback: `0` },
  { name: 'webhook_active', fallback: `NULL` },
  { name: 'webhook_last_checked_at', fallback: `NULL` },
  { name: 'webhook_last_error', fallback: `NULL` },
  { name: 'webhook_configured_at', fallback: `NULL` },
  { name: 'last_webhook_at', fallback: `NULL` },
  { name: 'last_poll_at', fallback: `NULL` },
  { name: 'poll_cursor', fallback: `NULL` },
  { name: 'created_at', fallback: `0` },
  { name: 'updated_at', fallback: `0` },
];

export const GITHUB_SESSION_SETTINGS_COLUMNS: Array<{ name: string; fallback: string }> = [
  { name: 'space_id', fallback: `''` },
  { name: 'enabled', fallback: `1` },
  { name: 'polling_intent', fallback: `0` },
  { name: 'filter_current_user', fallback: `1` },
  { name: 'created_at', fallback: `0` },
  { name: 'updated_at', fallback: `0` },
];

export function githubTableColumns(db: BunDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name
    )
  );
}

export function legacyGitHubSessionRows(
  db: BunDatabase,
  legacyTable: string,
  columns: Array<{ name: string; fallback: string }>
): Record<string, unknown>[] {
  const present = githubTableColumns(db, legacyTable);
  const selects = columns
    .map(({ name, fallback }) =>
      present.has(name) ? `${name} AS ${name}` : `${fallback} AS ${name}`
    )
    .join(', ');
  return db
    .prepare(`SELECT ${selects} FROM ${legacyTable} WHERE space_id = '${SESSION_SCOPE}'`)
    .all() as Record<string, unknown>[];
}

export function githubRowsEqual(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  columns: Array<{ name: string }>
): boolean {
  return columns.every(({ name }) => incoming[name] === existing[name]);
}

function reconcileSessionWatchedKeys(db: BunDatabase): void {
  if (!schemaTableExists(db, LEGACY_WATCHED_TABLE)) return;
  const rows = legacyGitHubSessionRows(db, LEGACY_WATCHED_TABLE, GITHUB_SESSION_WATCHED_COLUMNS);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO github_session_watched_repos
       (${GITHUB_SESSION_WATCHED_COLUMNS.map((c) => c.name).join(', ')})
     VALUES (${GITHUB_SESSION_WATCHED_COLUMNS.map(() => '?').join(', ')})`
  );
  db.transaction(() => {
    for (const row of rows) {
      insert.run(...GITHUB_SESSION_WATCHED_COLUMNS.map((c) => row[c.name] as never));
    }
    db.prepare(
      `DELETE FROM github_session_watched_repos
         WHERE space_id = '${SESSION_SCOPE}'
           AND NOT EXISTS (
             SELECT 1 FROM ${LEGACY_WATCHED_TABLE} l
             WHERE l.space_id = '${SESSION_SCOPE}'
               AND lower(l.owner) = lower(github_session_watched_repos.owner)
               AND lower(l.repo) = lower(github_session_watched_repos.repo)
           )`
    ).run();
  })();
}

export function createGitHubSessionTables(db: BunDatabase): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS github_session_watched_repos (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        webhook_enabled INTEGER NOT NULL DEFAULT 1,
        polling_enabled INTEGER NOT NULL DEFAULT 0,
        webhook_secret TEXT,
        webhook_remote_id INTEGER,
        webhook_url TEXT,
        webhook_auto_registered INTEGER NOT NULL DEFAULT 0,
        webhook_active INTEGER,
        webhook_last_checked_at INTEGER,
        webhook_last_error TEXT,
        webhook_configured_at INTEGER,
        last_webhook_at INTEGER,
        last_poll_at INTEGER,
        poll_cursor TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, owner, repo)
      )
    `);
  db.exec(`
      CREATE TABLE IF NOT EXISTS github_session_source_settings (
        space_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        polling_intent INTEGER NOT NULL DEFAULT 0,
        filter_current_user INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  reconcileSessionWatchedKeys(db);
}

export function createGitHubSessionIndexes(db: BunDatabase): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_github_session_watched_repo_lookup ON github_session_watched_repos(owner, repo, enabled)`
  );
}
