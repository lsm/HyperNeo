import type { Database as BunDatabase } from '../sqlite-compat.ts';
import { schemaTableExists } from './extensions.ts';

const SPACE_GITHUB_WATCHED_REPOS_DDL = `
      CREATE TABLE IF NOT EXISTS space_github_watched_repos (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        webhook_enabled INTEGER NOT NULL DEFAULT 1,
        polling_enabled INTEGER NOT NULL DEFAULT 0,
        webhook_secret TEXT,
        last_webhook_at INTEGER,
        last_poll_at INTEGER,
        poll_cursor TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        webhook_remote_id INTEGER,
        webhook_url TEXT,
        webhook_auto_registered INTEGER NOT NULL DEFAULT 0,
        webhook_active INTEGER,
        webhook_last_checked_at INTEGER,
        webhook_last_error TEXT,
        webhook_configured_at INTEGER,
        UNIQUE(space_id, owner, repo)
      )
    `;

const SPACE_GITHUB_EVENTS_DDL = `
      CREATE TABLE IF NOT EXISTS space_github_events (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        task_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('webhook', 'polling')),
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        action TEXT NOT NULL,
        repo_owner TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        pr_url TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        external_url TEXT NOT NULL DEFAULT '',
        external_id TEXT NOT NULL DEFAULT '',
        occurred_at INTEGER NOT NULL,
        dedupe_key TEXT NOT NULL,
        raw_payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received', 'processed', 'ignored', 'ambiguous', 'routed', 'delivered', 'failed')),
        matched_by TEXT,
        confidence TEXT,
        route_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(space_id, dedupe_key)
      )
    `;

function createSpaceGitHubTableDefinitions(db: BunDatabase): void {
  db.exec(SPACE_GITHUB_WATCHED_REPOS_DDL);
  db.exec(SPACE_GITHUB_EVENTS_DDL);
  db.exec(`
      CREATE TABLE IF NOT EXISTS space_github_source_settings (
        space_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
}

export function createSpaceGitHubTables(db: BunDatabase): void {
  createSpaceGitHubTableDefinitions(db);
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(space_github_source_settings)').all() as Array<{
      name: string;
    }>;
    const pollingIntentAdded = !columns.some((column) => column.name === 'polling_intent');
    if (pollingIntentAdded) {
      db.exec(
        'ALTER TABLE space_github_source_settings ADD COLUMN polling_intent INTEGER NOT NULL DEFAULT 0'
      );
    }
    if (!columns.some((column) => column.name === 'filter_current_user')) {
      db.exec(
        'ALTER TABLE space_github_source_settings ADD COLUMN filter_current_user INTEGER NOT NULL DEFAULT 1'
      );
    }
    if (!schemaTableExists(db, 'spaces')) return;
    const now = Date.now();
    db.prepare(
      `INSERT INTO space_github_source_settings (space_id, enabled, polling_intent, created_at, updated_at)
         SELECT DISTINCT s.space_id, 1, 1, ?, ?
         FROM space_github_watched_repos s
         JOIN spaces sp ON sp.id = s.space_id
         WHERE s.polling_enabled = 1
         ON CONFLICT(space_id) DO UPDATE SET
           polling_intent = excluded.polling_intent,
           updated_at = excluded.updated_at
         WHERE polling_intent = 0`
    ).run(now, now);
  })();
}

export function createSpaceGitHubBaselineObjects(db: BunDatabase): void {
  db.exec(SPACE_GITHUB_WATCHED_REPOS_DDL);
  db.exec(SPACE_GITHUB_EVENTS_DDL);
  createSpaceGitHubIndexes(db);
}

export function createSpaceGitHubIndexes(db: BunDatabase): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_watched_repo_lookup ON space_github_watched_repos(owner, repo, enabled)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_task ON space_github_events(task_id, occurred_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_space_github_events_repo ON space_github_events(space_id, repo_owner, repo_name, pr_number)`
  );
}
