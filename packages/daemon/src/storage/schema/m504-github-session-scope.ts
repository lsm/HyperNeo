import type { Database } from '../sqlite-compat.ts';
import { schemaTableExists } from './extensions.ts';
import { createGitHubSessionTables } from './github-session-schema.ts';

const SESSION_SCOPE = 'sessions';
const MARKER_KEY = 'migration_504';

const WATCHED_COLUMNS: Array<{ name: string; fallback: string }> = [
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

const SETTINGS_COLUMNS: Array<{ name: string; fallback: string }> = [
  { name: 'space_id', fallback: `''` },
  { name: 'enabled', fallback: `1` },
  { name: 'polling_intent', fallback: `0` },
  { name: 'filter_current_user', fallback: `1` },
  { name: 'created_at', fallback: `0` },
  { name: 'updated_at', fallback: `0` },
];

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name
    )
  );
}

function legacyRowSource(
  db: Database,
  legacyTable: string,
  columns: Array<{ name: string; fallback: string }>
): Record<string, unknown>[] {
  const present = tableColumns(db, legacyTable);
  const selects = columns
    .map(({ name, fallback }) =>
      present.has(name) ? `${name} AS ${name}` : `${fallback} AS ${name}`
    )
    .join(', ');
  return db
    .prepare(`SELECT ${selects} FROM ${legacyTable} WHERE space_id = '${SESSION_SCOPE}'`)
    .all() as Record<string, unknown>[];
}

function rowsEqual(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>,
  columns: Array<{ name: string }>
): boolean {
  return columns.every(({ name }) => incoming[name] === existing[name]);
}

function copySessionWatchedRows(db: Database): number {
  if (!schemaTableExists(db, 'space_github_watched_repos')) return 0;
  const rows = legacyRowSource(db, 'space_github_watched_repos', WATCHED_COLUMNS);
  let copied = 0;
  const find = db.prepare(
    `SELECT * FROM github_session_watched_repos WHERE space_id = ? AND owner = ? AND repo = ?`
  );
  const insert = db.prepare(
    `INSERT INTO github_session_watched_repos (${WATCHED_COLUMNS.map((c) => c.name).join(', ')})
     VALUES (${WATCHED_COLUMNS.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    const existing = find.get(row.space_id, row.owner, row.repo) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      if (!rowsEqual(row, existing, WATCHED_COLUMNS)) {
        throw new Error(
          `migration_504: github_session_watched_repos already has a conflicting row for ` +
            `scope 'sessions' ${String(row.owner)}/${String(row.repo)}`
        );
      }
      continue;
    }
    insert.run(...WATCHED_COLUMNS.map((c) => row[c.name] as never));
    copied += 1;
  }
  return copied;
}

function copySessionSettingsRow(db: Database): boolean {
  if (!schemaTableExists(db, 'space_github_source_settings')) return false;
  const rows = legacyRowSource(db, 'space_github_source_settings', SETTINGS_COLUMNS);
  const row = rows[0];
  if (!row) return false;
  const existing = db
    .prepare(`SELECT * FROM github_session_source_settings WHERE space_id = ?`)
    .get(SESSION_SCOPE) as Record<string, unknown> | undefined;
  if (existing) {
    if (!rowsEqual(row, existing, SETTINGS_COLUMNS)) {
      throw new Error(
        `migration_504: github_session_source_settings already has a conflicting row for scope 'sessions'`
      );
    }
    return false;
  }
  db.prepare(
    `INSERT INTO github_session_source_settings (${SETTINGS_COLUMNS.map((c) => c.name).join(', ')})
     VALUES (${SETTINGS_COLUMNS.map(() => '?').join(', ')})`
  ).run(...SETTINGS_COLUMNS.map((c) => row[c.name] as never));
  return true;
}

export function runMigration504(db: Database): void {
  createGitHubSessionTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_markers (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  db.transaction(() => {
    copySessionWatchedRows(db);
    copySessionSettingsRow(db);
    db.prepare(
      `INSERT OR IGNORE INTO github_session_source_settings
         (space_id, enabled, polling_intent, created_at, updated_at)
       SELECT '${SESSION_SCOPE}', 1, 1, 0, 0
       WHERE EXISTS (
         SELECT 1 FROM github_session_watched_repos
         WHERE space_id = '${SESSION_SCOPE}' AND polling_enabled = 1
       )`
    ).run();
    db.prepare(`INSERT OR IGNORE INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
      MARKER_KEY,
      Date.now()
    );
  })();
}
