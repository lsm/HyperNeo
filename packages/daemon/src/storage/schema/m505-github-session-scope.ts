import type { Database } from '../sqlite-compat.ts';
import { GITHUB_SESSION_SCOPE } from '../repositories/github-scope.ts';
import { schemaTableExists } from './extensions.ts';
import {
  createGitHubSessionTables,
  GITHUB_SESSION_SETTINGS_COLUMNS,
  GITHUB_SESSION_WATCHED_COLUMNS,
  githubRowsEqual,
  legacyGitHubSessionRows,
} from './github-session-schema.ts';

const MARKER_KEY = 'migration_505';

function copySessionWatchedRows(db: Database): number {
  if (!schemaTableExists(db, 'space_github_watched_repos')) return 0;
  const rows = legacyGitHubSessionRows(
    db,
    'space_github_watched_repos',
    GITHUB_SESSION_WATCHED_COLUMNS
  );
  let copied = 0;
  const find = db.prepare(
    `SELECT * FROM github_session_watched_repos WHERE space_id = ? AND owner = ? AND repo = ?`
  );
  const insert = db.prepare(
    `INSERT INTO github_session_watched_repos (${GITHUB_SESSION_WATCHED_COLUMNS.map((c) => c.name).join(', ')})
     VALUES (${GITHUB_SESSION_WATCHED_COLUMNS.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    const existing = find.get(row.space_id, row.owner, row.repo) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      if (!githubRowsEqual(row, existing, GITHUB_SESSION_WATCHED_COLUMNS)) {
        throw new Error(
          `migration_505: github_session_watched_repos already has a conflicting row for ` +
            `scope 'sessions' ${String(row.owner)}/${String(row.repo)}`
        );
      }
      continue;
    }
    insert.run(...GITHUB_SESSION_WATCHED_COLUMNS.map((c) => row[c.name] as never));
    copied += 1;
  }
  return copied;
}

function copySessionSettingsRow(db: Database): boolean {
  if (!schemaTableExists(db, 'space_github_source_settings')) return false;
  const rows = legacyGitHubSessionRows(
    db,
    'space_github_source_settings',
    GITHUB_SESSION_SETTINGS_COLUMNS
  );
  const row = rows[0];
  if (!row) return false;
  const existing = db
    .prepare(`SELECT * FROM github_session_source_settings WHERE space_id = ?`)
    .get(GITHUB_SESSION_SCOPE) as Record<string, unknown> | undefined;
  if (existing) {
    if (!githubRowsEqual(row, existing, GITHUB_SESSION_SETTINGS_COLUMNS)) {
      throw new Error(
        `migration_505: github_session_source_settings already has a conflicting row for scope 'sessions'`
      );
    }
    return false;
  }
  db.prepare(
    `INSERT INTO github_session_source_settings (${GITHUB_SESSION_SETTINGS_COLUMNS.map((c) => c.name).join(', ')})
     VALUES (${GITHUB_SESSION_SETTINGS_COLUMNS.map(() => '?').join(', ')})`
  ).run(...GITHUB_SESSION_SETTINGS_COLUMNS.map((c) => row[c.name] as never));
  return true;
}

export function runMigration505(db: Database): void {
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
       SELECT '${GITHUB_SESSION_SCOPE}', 1, 1, 0, 0
       WHERE EXISTS (
         SELECT 1 FROM github_session_watched_repos
         WHERE space_id = '${GITHUB_SESSION_SCOPE}' AND polling_enabled = 1
       )`
    ).run();
    db.prepare(`INSERT OR IGNORE INTO migration_markers (key, applied_at) VALUES (?, ?)`).run(
      MARKER_KEY,
      Date.now()
    );
  })();
}
