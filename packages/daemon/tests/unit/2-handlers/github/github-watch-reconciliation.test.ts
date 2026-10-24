import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository.ts';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension.ts';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import {
  GitHubWatchInventory,
  reportGitHubWatchHealth,
} from '../../../../src/lib/external-events/github/github-watch-inventory.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';

describe('GitHub watch reconciliation', () => {
  test('startup and cycles restore subscriptions and todo-only watches', async () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.exec(
      `INSERT INTO sessions (id, title, workspace_path, status, created_at, last_active_at, config, metadata) VALUES ('owner','Owner','/tmp','active',1,1,'{}','{}')`
    );
    const subscriptions = new SessionEventSubscriptionRepository(db);
    subscriptions.upsert({
      sessionId: 'owner',
      topic: 'github/fixture/subscribed/pull_request/162.*',
    });
    db.exec(`INSERT INTO neo_asks (id,session_id,title,request,status,created_at,updated_at) VALUES ('ask','owner','Ask','Request','open',1,1);
      INSERT INTO neo_todos (id,ask_id,position,title,done_when,repo,check_json,state,created_at,updated_at) VALUES ('todo','ask',0,'Todo','Done','fixture/todo','{"pack":"coding","kind":"pr","params":{}}','doing',1,1)`);
    const inventory = new GitHubWatchInventory(db, subscriptions);
    const extension = new GitHubEventExtension(db, undefined, {
      pollIntervalMs: 0,
      sessionWatchRepos: () => inventory.list(),
      sessionRepoReferenced: (owner, repo) => inventory.references(owner, repo),
      fetchImpl: (async () => Response.json([])) as typeof fetch,
    });
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    await extension.start({
      config,
      publisher: { publish: async () => ({}) },
      onSourceConfigChanged: () => {},
    });
    try {
      expect(
        extension.repo
          .listPollingRepos()
          .map((row) => row.repo)
          .sort()
      ).toEqual(['subscribed', 'todo']);
      extension.repo.removeWatchedRepo('sessions', 'fixture', 'subscribed');
      await extension.pollOnce();
      expect(
        extension.repo
          .listPollingRepos()
          .map((row) => row.repo)
          .sort()
      ).toEqual(['subscribed', 'todo']);
      db.exec("UPDATE neo_todos SET state='done'");
      await extension.pollOnce();
      expect(extension.repo.listPollingRepos().map((row) => row.repo)).toEqual(['subscribed']);
    } finally {
      await extension.stop();
      db.close();
    }
  });
  test('inventory excludes finished work, archived subscribers, wildcards and invalid repository names', () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    db.exec(`INSERT INTO sessions (id,title,workspace_path,status,created_at,last_active_at,config,metadata) VALUES ('archived','Archived','/tmp','archived',1,1,'{}','{}');
      INSERT INTO neo_asks (id,session_id,title,request,status,repo,created_at,updated_at) VALUES ('ask','archived','Ask','Request','open','fixture/fallback',1,1)`);
    const subscriptions = new SessionEventSubscriptionRepository(db);
    subscriptions.upsert({
      sessionId: 'archived',
      topic: 'github/fixture/archived/pull_request/1.*',
    });
    const insert = db.prepare(
      `INSERT INTO neo_todos (id,ask_id,position,title,done_when,repo,check_json,state,created_at,updated_at) VALUES (?,'ask',0,'Todo','Done',?,? ,?,1,1)`
    );
    insert.run('fallback', null, '{"pack":"coding"}', 'blocked');
    insert.run('done', 'fixture/done', '{"pack":"coding"}', 'done');
    insert.run('other', 'fixture/other', '{"pack":"lifeAdmin"}', 'todo');
    insert.run('wildcard', 'fixture/*', '{"pack":"coding"}', 'doing');
    insert.run('invalid', 'https://github.com/fixture/repo', '{"pack":"coding"}', 'doing');
    try {
      expect(new GitHubWatchInventory(db, subscriptions).list()).toEqual([
        { owner: 'fixture', repo: 'fallback' },
      ]);
      db.exec("UPDATE neo_asks SET status='done'");
      expect(new GitHubWatchInventory(db, subscriptions).list()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('three missed cycles persist a concern and recovery retries delivery', async () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    createCodingPackTables(db);
    const ledger = new CodingPrLedgerRepository(db);
    const watched = new GitHubEventExtension(db).repo.upsertWatchedRepo({
      spaceId: 'sessions',
      owner: 'fixture',
      repo: 'stale',
      pollingEnabled: true,
    });
    const notices: string[] = [];
    const wake = async (_key: string, text: string) => {
      notices.push(text);
      return true;
    };
    try {
      for (const at of [1, 2])
        await reportGitHubWatchHealth(ledger, [watched], new Set(), wake, at);
      expect(notices).toHaveLength(0);
      await reportGitHubWatchHealth(ledger, [watched], new Set(), async () => false, 3);
      expect(ledger.health.read('polling:fixture/stale')?.notices?.[0].acceptedAt).toBeNull();
      await reportGitHubWatchHealth(ledger, [watched], new Set([watched.id]), wake, 4);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toContain('stalled');
      expect(notices[1]).toContain('recovered');
      await reportGitHubWatchHealth(ledger, [watched], new Set([watched.id]), wake, 5);
      expect(notices).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
