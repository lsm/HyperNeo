import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration111, runMigrations } from '../../../../../src/storage/schema';
import { runMigration504 } from '../../../../../src/storage/schema/m504-github-session-scope.ts';
import { createSpaceGitHubTables } from '../../../../../src/storage/schema/space-github.ts';
import { createGitHubSessionTables } from '../../../../../src/storage/schema/github-session-schema.ts';

const WATCHED_COLUMNS = [
  'id',
  'space_id',
  'owner',
  'repo',
  'enabled',
  'webhook_enabled',
  'polling_enabled',
  'webhook_secret',
  'webhook_remote_id',
  'webhook_url',
  'webhook_auto_registered',
  'webhook_active',
  'webhook_last_checked_at',
  'webhook_last_error',
  'webhook_configured_at',
  'last_webhook_at',
  'last_poll_at',
  'poll_cursor',
  'created_at',
  'updated_at',
];

const SETTINGS_COLUMNS = [
  'space_id',
  'enabled',
  'polling_intent',
  'filter_current_user',
  'created_at',
  'updated_at',
];

function modernWatchedRow(
  overrides: Record<string, string | number | null> = {}
): Record<string, string | number | null> {
  return {
    id: 'watch-1',
    space_id: 'sessions',
    owner: 'SyntheticOrg',
    repo: 'synthetic-repo',
    enabled: 1,
    webhook_enabled: 0,
    polling_enabled: 1,
    webhook_secret: 'synthetic-secret',
    webhook_remote_id: 42,
    webhook_url: 'https://example.invalid/hook',
    webhook_auto_registered: 1,
    webhook_active: 0,
    webhook_last_checked_at: 101,
    webhook_last_error: 'synthetic error',
    webhook_configured_at: 102,
    last_webhook_at: 103,
    last_poll_at: 104,
    poll_cursor: '{"lastSeenAt":105,"etags":{"issues":"synthetic-etag"}}',
    created_at: 106,
    updated_at: 107,
    ...overrides,
  };
}

function insertWatched(
  db: Database,
  table: string,
  row: Record<string, string | number | null>
): void {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map((key) => row[key]));
}

function watchedRows(db: Database, table: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT ${WATCHED_COLUMNS.join(', ')} FROM ${table} ORDER BY owner, repo`)
    .all() as Record<string, unknown>[];
}

function settingsRows(db: Database, table: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT ${SETTINGS_COLUMNS.join(', ')} FROM ${table} ORDER BY space_id`)
    .all() as Record<string, unknown>[];
}

describe('migration 504 GitHub session scope', () => {
  test('creates empty session tables on a database without legacy tables', () => {
    const db = new Database(':memory:');
    runMigration504(db);
    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([]);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([]);
    expect(
      db.prepare(`SELECT key FROM migration_markers WHERE key = 'migration_504'`).get()
    ).toEqual({ key: 'migration_504' });
    db.close();
  });

  test('copies session rows byte-for-byte and leaves legacy rows in place', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    const session = modernWatchedRow();
    const spaceRow = modernWatchedRow({
      id: 'watch-2',
      space_id: 'space-a',
      owner: 'SpaceOrg',
      repo: 'space-repo',
    });
    insertWatched(db, 'space_github_watched_repos', session);
    insertWatched(db, 'space_github_watched_repos', spaceRow);
    db.prepare(
      `INSERT INTO space_github_source_settings (${SETTINGS_COLUMNS.join(', ')})
       VALUES (${SETTINGS_COLUMNS.map(() => '?').join(', ')})`
    ).run('sessions', 0, 0, 0, 200, 201);

    runMigration504(db);

    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([session]);
    expect(watchedRows(db, 'space_github_watched_repos')).toEqual([spaceRow, session]);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([
      {
        space_id: 'sessions',
        enabled: 0,
        polling_intent: 0,
        filter_current_user: 0,
        created_at: 200,
        updated_at: 201,
      },
    ]);
    expect(settingsRows(db, 'space_github_source_settings')).toEqual([
      {
        space_id: 'sessions',
        enabled: 0,
        polling_intent: 0,
        filter_current_user: 0,
        created_at: 200,
        updated_at: 201,
      },
    ]);
    db.close();
  });

  test('does not copy rows for other scopes', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow({ space_id: 'space-a' }));
    runMigration504(db);
    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([]);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([]);
    db.close();
  });

  test('derives session polling intent from polling watches only when no settings row exists', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow({ polling_enabled: 1 }));
    runMigration504(db);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([
      {
        space_id: 'sessions',
        enabled: 1,
        polling_intent: 1,
        filter_current_user: 1,
        created_at: 0,
        updated_at: 0,
      },
    ]);
    db.close();
  });

  test('keeps an explicit false intent instead of deriving one', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow({ polling_enabled: 1 }));
    db.prepare(
      `INSERT INTO space_github_source_settings (${SETTINGS_COLUMNS.join(', ')})
       VALUES (${SETTINGS_COLUMNS.map(() => '?').join(', ')})`
    ).run('sessions', 1, 0, 1, 10, 11);
    runMigration504(db);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([
      {
        space_id: 'sessions',
        enabled: 1,
        polling_intent: 0,
        filter_current_user: 1,
        created_at: 10,
        updated_at: 11,
      },
    ]);
    db.close();
  });

  test('substitutes schema defaults for legacy columns that never existed', () => {
    const db = new Database(':memory:');
    runMigration111(db);
    db.exec(`CREATE TABLE space_github_source_settings (
      space_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO space_github_watched_repos
         (id, space_id, owner, repo, enabled, webhook_enabled, polling_enabled, webhook_secret,
          last_webhook_at, last_poll_at, poll_cursor, created_at, updated_at)
       VALUES ('watch-old', 'sessions', 'OldOrg', 'old-repo', 0, 1, 1, 'synthetic-secret',
               55, 56, '{"lastSeenAt":57}', 58, 59)`
    ).run();
    db.prepare(
      `INSERT INTO space_github_source_settings (space_id, enabled, created_at, updated_at)
       VALUES ('sessions', 0, 60, 61)`
    ).run();

    runMigration504(db);

    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([
      {
        id: 'watch-old',
        space_id: 'sessions',
        owner: 'OldOrg',
        repo: 'old-repo',
        enabled: 0,
        webhook_enabled: 1,
        polling_enabled: 1,
        webhook_secret: 'synthetic-secret',
        webhook_remote_id: null,
        webhook_url: null,
        webhook_auto_registered: 0,
        webhook_active: null,
        webhook_last_checked_at: null,
        webhook_last_error: null,
        webhook_configured_at: null,
        last_webhook_at: 55,
        last_poll_at: 56,
        poll_cursor: '{"lastSeenAt":57}',
        created_at: 58,
        updated_at: 59,
      },
    ]);
    expect(settingsRows(db, 'github_session_source_settings')).toEqual([
      {
        space_id: 'sessions',
        enabled: 0,
        polling_intent: 0,
        filter_current_user: 1,
        created_at: 60,
        updated_at: 61,
      },
    ]);
    db.close();
  });

  test('runs twice without duplicating rows or failing on the marker', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow());
    runMigration504(db);
    runMigration504(db);
    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([modernWatchedRow()]);
    db.close();
  });

  test('refuses to start over a conflicting row and rolls back the transaction', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    createGitHubSessionTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow());
    insertWatched(
      db,
      'space_github_watched_repos',
      modernWatchedRow({ id: 'watch-3', repo: 'second' })
    );
    insertWatched(
      db,
      'github_session_watched_repos',
      modernWatchedRow({ poll_cursor: '{"lastSeenAt":999}' })
    );
    expect(() => runMigration504(db)).toThrow(
      /migration_504: github_session_watched_repos already has a conflicting row/
    );
    expect(watchedRows(db, 'github_session_watched_repos').map((row) => row.repo)).toEqual([
      'synthetic-repo',
    ]);
    expect(
      db.prepare(`SELECT poll_cursor FROM github_session_watched_repos WHERE id = 'watch-1'`).get()
    ).toEqual({ poll_cursor: '{"lastSeenAt":999}' });
    expect(db.prepare(`SELECT key FROM migration_markers`).all()).toEqual([]);
    expect(watchedRows(db, 'space_github_watched_repos')).toHaveLength(2);
    db.close();
  });

  test('refuses to start over conflicting session settings', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    createGitHubSessionTables(db);
    db.prepare(
      `INSERT INTO space_github_source_settings (${SETTINGS_COLUMNS.join(', ')})
       VALUES (${SETTINGS_COLUMNS.map(() => '?').join(', ')})`
    ).run('sessions', 1, 1, 1, 300, 301);
    db.prepare(
      `INSERT INTO github_session_source_settings (${SETTINGS_COLUMNS.join(', ')})
       VALUES (${SETTINGS_COLUMNS.map(() => '?').join(', ')})`
    ).run('sessions', 1, 0, 1, 300, 301);
    expect(() => runMigration504(db)).toThrow(
      /migration_504: github_session_source_settings already has a conflicting row/
    );
    expect(db.prepare(`SELECT key FROM migration_markers`).all()).toEqual([]);
    db.close();
  });

  test('skips an identical pre-existing session row', () => {
    const db = new Database(':memory:');
    createSpaceGitHubTables(db);
    createGitHubSessionTables(db);
    insertWatched(db, 'space_github_watched_repos', modernWatchedRow());
    insertWatched(db, 'github_session_watched_repos', modernWatchedRow());
    runMigration504(db);
    expect(watchedRows(db, 'github_session_watched_repos')).toEqual([modernWatchedRow()]);
    db.close();
  });

  test('does not migrate session rows out of the events table', () => {
    const db = new Database(':memory:');
    runMigration111(db);
    db.prepare(
      `INSERT INTO space_github_events (
        id, space_id, task_id, source, delivery_id, event_type, action, repo_owner, repo_name,
        pr_number, pr_url, actor, actor_type, occurred_at, dedupe_key, raw_payload, state,
        created_at, updated_at
      ) VALUES ('event-1', 'sessions', NULL, 'webhook', 'delivery-1', 'pull_request', 'opened',
        'Org', 'Repo', 1, 'https://example.invalid/pr/1', 'dev', 'User', 1, 'key-1', '{}',
        'received', 1, 1)`
    ).run();
    runMigration504(db);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM space_github_events`).get()).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'github_session%'`
        )
        .all()
        .map((row) => (row as { name: string }).name)
        .sort()
    ).toEqual(['github_session_source_settings', 'github_session_watched_repos']);
    db.close();
  });

  test('first Space enablement on a database without spaces tolerates pre-existing github tables', () => {
    const db = new Database(':memory:');
    runMigration111(db);
    db.exec(`CREATE TABLE migration_markers (key TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    db.exec(
      `CREATE TABLE migration_space_reclaims (migration_key TEXT PRIMARY KEY, reclaimed_at INTEGER NOT NULL)`
    );
    for (let version = 1; version <= 238; version++)
      db.prepare(`INSERT INTO migration_markers (key, applied_at) VALUES (?, 1)`).run(
        `migration_${version}`
      );
    runMigrations(db, () => {});
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN
           ('spaces', 'space_github_watched_repos', 'space_github_events', 'github_session_watched_repos')`
        )
        .all()
        .map((row) => (row as { name: string }).name)
        .sort()
    ).toEqual([
      'github_session_watched_repos',
      'space_github_events',
      'space_github_watched_repos',
      'spaces',
    ]);
    db.close();
  });
});
