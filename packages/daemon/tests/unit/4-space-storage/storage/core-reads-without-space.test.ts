import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMemoryRepository,
  type AgentMemoryEmbedder,
} from '../../../../src/storage/repositories/agent-memory-repository.ts';
import { DaemonInventoryRepository } from '../../../../src/storage/repositories/daemon-inventory-repository.ts';
import {
  countGitHubSpacesWithPollingIntent,
  listGitHubPollingConfiguredRepos,
  listGitHubPollingRepos,
} from '../../../../src/storage/repositories/github-polling-repos-read.ts';
import { persistGitHubWatchedRepoInsert } from '../../../../src/storage/repositories/github-watched-insert-persist.ts';
import { persistGitHubPollCursorJson } from '../../../../src/storage/repositories/github-cursor-persist.ts';
import { listGitHubWatchedRepos } from '../../../../src/storage/repositories/github-watched-repos-read.ts';
import {
  findGitHubWatchedRepo,
  findGitHubWatchedRepoById,
} from '../../../../src/storage/repositories/github-watched-repo-lookups.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { readWorkTurnPage } from '../../../../src/storage/work-turn-page.ts';

describe('core reads with Space tables absent', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    db.exec(`CREATE TABLE IF NOT EXISTS space_github_source_settings (
      space_id TEXT PRIMARY KEY, polling_intent INTEGER NOT NULL DEFAULT 0
    )`);
    db.prepare(
      `INSERT INTO sessions (id,title,created_at,last_active_at,status,config,metadata)
       VALUES ('worker','worker','2026-10-20','2026-10-20','active','{}','{}')`
    ).run();
    for (const table of ['spaces', 'space_tasks']) {
      expect(
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
      ).toBeFalsy();
    }
  });
  afterEach(() => db.close());

  it('readWorkTurnPage reads turns without the task filter', () => {
    db.prepare(
      `INSERT INTO sdk_messages (id,session_id,message_type,sdk_message,timestamp,send_status)
       VALUES ('m1','worker','user',?,'2026-10-20T00:00:00.000Z','consumed')`
    ).run(JSON.stringify({ type: 'user', message: { content: 'hello' } }));
    expect(readWorkTurnPage(db, 'worker', undefined, 5, 0)).toMatchObject({
      turns: [{ messageId: 'm1', text: 'hello' }],
    });
  });

  it('DaemonInventoryRepository reports Space kinds as empty', () => {
    const bare = new Database(':memory:');
    bare.exec(`CREATE TABLE neo_session_bindings (session_id TEXT PRIMARY KEY);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, status TEXT, last_active_at TEXT, main_repo_path TEXT,
        metadata TEXT, workspace_path TEXT, space_id TEXT, parent_id TEXT, processing_state TEXT,
        task_id TEXT, type TEXT, session_context TEXT
      );
      INSERT INTO sessions (id, title, status) VALUES ('worker', 'worker', 'active')`);
    const repo = new DaemonInventoryRepository(bare);
    const pages = repo.read({ limit: 5, includeArchived: false });
    expect(pages.map(({ kind, total }) => [kind, total])).toEqual([
      ['session', 1],
      ['space', 0],
      ['task', 0],
      ['agent', 0],
      ['workflow', 0],
      ['workflow_run', 0],
      ['goal', 0],
      ['evolution_scope', 0],
    ]);
    expect(repo.readSession('worker')).toMatchObject({ id: 'worker', scopeOwned: 0 });
    bare.close();
  });

  it('AgentMemoryRepository skips the embedding backfill', () => {
    const embedder = { model: 'm', dimensions: 1 } as AgentMemoryEmbedder;
    const bare = new Database(':memory:');
    const repo = new AgentMemoryRepository(bare, undefined, embedder);
    const prepare = vi.spyOn(bare, 'prepare');
    repo.backfillPendingEmbeddings();
    expect(prepare.mock.calls.flat().join(' ')).not.toContain('memory_vectors');
    bare.close();
  });

  it('GitHub polling reads that join spaces return nothing', () => {
    expect(countGitHubSpacesWithPollingIntent(db)).toBe(0);
    expect(listGitHubPollingConfiguredRepos(db)).toEqual([]);
    expect(listGitHubPollingConfiguredRepos(db, 'sessions')).toEqual([]);
  });

  it('session watches write to and read from the session tables', () => {
    persistGitHubWatchedRepoInsert(
      db,
      {
        spaceId: 'sessions',
        owner: 'SyntheticOrg',
        repo: 'synthetic-repo',
        webhookEnabled: false,
        pollingEnabled: true,
      },
      'watch-1',
      true,
      500
    );
    persistGitHubPollCursorJson(db, 'watch-1', { lastSeenAt: 900 });

    expect(listGitHubWatchedRepos(db, 'sessions')).toMatchObject([
      {
        id: 'watch-1',
        spaceId: 'sessions',
        pollingEnabled: true,
        pollCursor: { lastSeenAt: 900 },
      },
    ]);
    expect(listGitHubPollingRepos(db, 'sessions').map((row) => row.id)).toEqual(['watch-1']);
    expect(findGitHubWatchedRepo(db, 'sessions', 'SyntheticOrg', 'synthetic-repo')).toMatchObject({
      id: 'watch-1',
    });
    expect(findGitHubWatchedRepoById(db, 'watch-1')).toMatchObject({ id: 'watch-1' });
    expect(
      db.prepare(`SELECT poll_cursor FROM github_session_watched_repos WHERE id = 'watch-1'`).get()
    ).toEqual({ poll_cursor: '{"lastSeenAt":900}' });
  });

  it('stale rows left in the legacy table stay unread', () => {
    db.exec(`INSERT INTO space_github_watched_repos
      (id, space_id, owner, repo, polling_enabled, created_at, updated_at)
      VALUES ('stale', 'sessions', 'OldOrg', 'old-repo', 1, 1, 1)`);
    expect(listGitHubWatchedRepos(db)).toEqual([]);
    expect(listGitHubWatchedRepos(db, 'sessions')).toEqual([]);
    expect(listGitHubPollingRepos(db, 'sessions')).toEqual([]);
    expect(findGitHubWatchedRepoById(db, 'stale')).toBeNull();
    persistGitHubPollCursorJson(db, 'stale', { lastSeenAt: 1 });
    expect(
      db.prepare(`SELECT poll_cursor FROM space_github_watched_repos WHERE id = 'stale'`).get()
    ).toEqual({ poll_cursor: null });
  });

  it('space-off databases with the legacy tables still answer session reads', () => {
    const bare = new Database(':memory:');
    try {
      bare.exec(`CREATE TABLE space_github_watched_repos (
        id TEXT PRIMARY KEY, space_id TEXT, owner TEXT, repo TEXT,
        enabled INTEGER, webhook_enabled INTEGER, polling_enabled INTEGER,
        webhook_secret TEXT, webhook_remote_id INTEGER, webhook_url TEXT,
        webhook_auto_registered INTEGER, webhook_active INTEGER,
        webhook_last_checked_at INTEGER, webhook_last_error TEXT,
        webhook_configured_at INTEGER, last_webhook_at INTEGER, last_poll_at INTEGER,
        poll_cursor TEXT, created_at INTEGER, updated_at INTEGER
      )`);
      bare.exec(`INSERT INTO space_github_watched_repos
        (id, space_id, owner, repo, enabled, polling_enabled, created_at, updated_at)
        VALUES ('live', 'space-a', 'Org', 'Repo', 1, 1, 1, 1),
               ('stale', 'sessions', 'OldOrg', 'old-repo', 1, 1, 1, 1)`);
      expect(listGitHubWatchedRepos(bare).map((row) => row.id)).toEqual(['live']);
      expect(listGitHubPollingRepos(bare).map((row) => row.id)).toEqual(['live']);
      expect(listGitHubWatchedRepos(bare, 'sessions')).toEqual([]);
    } finally {
      bare.close();
    }
  });
});
