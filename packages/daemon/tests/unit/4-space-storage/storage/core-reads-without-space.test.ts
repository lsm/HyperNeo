import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentMemoryRepository,
  type AgentMemoryEmbedder,
} from '../../../../src/storage/repositories/agent-memory-repository.ts';
import { DaemonInventoryRepository } from '../../../../src/storage/repositories/daemon-inventory-repository.ts';
import {
  countGitHubSpacesWithPollingIntent,
  listGitHubPollingConfiguredRepos,
} from '../../../../src/storage/repositories/github-polling-repos-read.ts';
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
});
