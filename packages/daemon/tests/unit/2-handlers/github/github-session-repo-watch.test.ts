import { afterEach, describe, expect, test } from 'bun:test';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import { githubRepoOfTopic } from '../../../../src/lib/external-events/subscription-operations';
import { SessionEventSubscriptionRepository } from '../../../../src/storage/repositories/session-event-subscription-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration329 } from '../../../../src/storage/schema/m329-session-event-subscriptions';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

let extension: GitHubEventExtension | null = null;
afterEach(async () => {
  await extension?.stop();
  extension = null;
});

async function started(
  db: BunDatabase,
  sessionRepoReferenced?: (owner: string, repo: string) => boolean
): Promise<GitHubEventExtension> {
  const created = new GitHubEventExtension(db, 'token', {
    getPollIntervalMs: () => 0,
    sessionRepoReferenced,
    fetchImpl: (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch,
  });
  extension = created;
  const config = new ExternalEventExtensionConfigStore(db);
  await config.setGlobalConfig('github', {
    source: 'github',
    globallyEnabled: true,
    capabilities: { polling: true },
  });
  await created.start({
    publisher: { publish: async (event) => ({ outcome: 'published', eventId: event.id }) },
    config,
    onSourceConfigChanged() {},
  });
  return created;
}

function freshDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  return db;
}

describe('watchSessionRepo', () => {
  test('watches a repo for sessions with polling on and webhooks off, once', async () => {
    const db = new BunDatabase(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    const github = await started(db);
    await github.watchSessionRepo('Acme', 'Widgets');
    const first = github.repo.getWatchedRepo(SESSION_EVENT_SCOPE, 'acme', 'widgets');
    expect(first).toMatchObject({
      spaceId: SESSION_EVENT_SCOPE,
      enabled: true,
      pollingEnabled: true,
      webhookEnabled: false,
    });
    await github.watchSessionRepo('acme', 'widgets');
    expect(github.repo.listPollingRepos(SESSION_EVENT_SCOPE).map((row) => row.id)).toEqual([
      first?.id ?? 'missing',
    ]);
  });

  test('does nothing before the extension has started', async () => {
    const db = new BunDatabase(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    extension = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 0 });
    await extension.watchSessionRepo('acme', 'widgets');
    expect(extension.repo.listPollingRepos(SESSION_EVENT_SCOPE)).toEqual([]);
  });
});

describe('unreferenced session watches', () => {
  test('a poll cycle drops a sessions-scope repo no subscription references any more', async () => {
    const db = freshDb();
    const referenced = new Set(['acme/kept']);
    const github = await started(db, (owner, repo) => referenced.has(`${owner}/${repo}`));
    await github.watchSessionRepo('acme', 'kept');
    await github.watchSessionRepo('acme', 'dropped');
    github.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'dropped',
      pollingEnabled: true,
      webhookEnabled: false,
    });
    await github.pollOnce();
    expect(github.repo.listPollingRepos(SESSION_EVENT_SCOPE).map((row) => row.repo)).toEqual([
      'kept',
    ]);
    expect(github.repo.listPollingRepos('space-1').map((row) => row.repo)).toEqual(['dropped']);
  });

  test('a subscription references its repo by topic, case-insensitively and literally', () => {
    const db = new BunDatabase(':memory:');
    runMigration329(db);
    const subs = new SessionEventSubscriptionRepository(db);
    subs.upsert({ sessionId: 's1', topic: 'github/Acme/my_repo/pull_request/7.*' });
    expect(subs.referencesRepo('acme', 'MY_REPO')).toBe(true);
    expect(subs.referencesRepo('acme', 'myxrepo')).toBe(false);
    expect(subs.referencesRepo('acme', 'my')).toBe(false);
  });
});

describe('githubRepoOfTopic', () => {
  test.each([
    ['github/Acme/Widgets/pull_request/7.*', { owner: 'Acme', repo: 'Widgets' }],
    ['github/acme/widgets/pull_request/*.review_*', { owner: 'acme', repo: 'widgets' }],
    ['github/*/widgets/pull_request/7.*', null],
    ['github/acme/*/pull_request/7.*', null],
    ['space/acme/widgets/x', null],
    ['github/acme', null],
  ] as const)('%s', (topic, expected) => {
    expect(githubRepoOfTopic(topic)).toEqual(expected);
  });
});
