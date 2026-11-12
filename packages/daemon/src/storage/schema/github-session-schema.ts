import type { Database as BunDatabase } from '../sqlite-compat.ts';

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
}

export function createGitHubSessionIndexes(db: BunDatabase): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_github_session_watched_repo_lookup ON github_session_watched_repos(owner, repo, enabled)`
  );
}
