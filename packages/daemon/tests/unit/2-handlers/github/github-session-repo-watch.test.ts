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

  test('watching an already watched repo turns polling back on if it was switched off', async () => {
    const db = freshDb();
    const created = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 60_000 });
    extension = created;
    const config = new ExternalEventExtensionConfigStore(db);
    await created.start({
      publisher: { publish: async (event) => ({ outcome: 'published', eventId: event.id }) },
      config,
      onSourceConfigChanged() {},
    });
    await created.watchSessionRepo('acme', 'widgets');
    const global = await config.getGlobalConfig('github');
    await config.setGlobalConfig('github', { ...global, capabilities: { polling: false } });
    await created.watchSessionRepo('acme', 'widgets');
    expect((await config.getGlobalConfig('github')).capabilities.polling).toBe(true);
  });

  test('records the watch before the extension has started, so start polls it', async () => {
    const db = freshDb();
    extension = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 0 });
    await extension.watchSessionRepo('acme', 'widgets');
    expect(extension.repo.listPollingRepos(SESSION_EVENT_SCOPE).map((row) => row.repo)).toEqual([
      'widgets',
    ]);
  });
});

describe('the first poll of a session watch', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const pr = (number: number, updatedMsAgo: number, state = 'open') => ({
    id: number * 10,
    number,
    state,
    title: `PR ${number}`,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    head: { sha: `sha-${number}` },
    user: { login: 'dev', type: 'User' },
    created_at: iso(updatedMsAgo),
    updated_at: iso(updatedMsAgo),
  });
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'X-RateLimit-Remaining': '5000' },
    });

  test('skips old PRs and reads a fresh approval in the same cycle', async () => {
    const db = freshDb();
    const topics: string[] = [];
    const pullsPages: string[] = [];
    const github = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 0 });
    extension = github;
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    await github.start({
      publisher: {
        publish: async (event) => {
          topics.push(event.topic);
          return { outcome: 'published', eventId: event.id };
        },
      },
      config,
      onSourceConfigChanged() {},
    });
    await github.watchSessionRepo('acme', 'widgets');
    const DAY = 24 * 60 * 60 * 1000;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (path.endsWith('/pulls')) {
        pullsPages.push(parsed.searchParams.get('page') ?? '');
        return ok([
          pr(7, 60_000),
          ...Array.from({ length: 99 }, (_, index) => pr(100 + index, 10 * DAY, 'closed')),
        ]);
      }
      if (path.endsWith('/pulls/7/reviews'))
        return ok([
          {
            id: 70,
            state: 'APPROVED',
            body: '',
            user: { login: 'reviewer[bot]', type: 'Bot' },
            submitted_at: iso(30_000),
            html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-70',
          },
        ]);
      if (path.endsWith('/check-runs')) return ok({ check_runs: [] });
      if (path.endsWith('/pulls/7')) return ok(pr(7, 60_000));
      return ok([]);
    }) as unknown as typeof fetch;
    await github.pollWatchedRepo(
      github.repo.listPollingRepos(SESSION_EVENT_SCOPE)[0] ?? fail(),
      fetchImpl
    );
    expect(pullsPages).toEqual(['1']);
    expect(topics).toContain('github/acme/widgets/pull_request/7.review_submitted');
    expect(topics.filter((topic) => /pull_request\/1\d\d\./.test(topic))).toEqual([]);
  });

  test('a window with no open PR does not fall back to walking the backlog next cycle', async () => {
    const db = freshDb();
    const topics: string[] = [];
    const pullsPages: string[] = [];
    const github = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 0 });
    extension = github;
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    await github.start({
      publisher: {
        publish: async (event) => {
          topics.push(event.topic);
          return { outcome: 'published', eventId: event.id };
        },
      },
      config,
      onSourceConfigChanged() {},
    });
    await github.watchSessionRepo('acme', 'widgets');
    const DAY = 24 * 60 * 60 * 1000;
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/pulls')) {
        pullsPages.push(parsed.searchParams.get('page') ?? '');
        return ok(Array.from({ length: 100 }, (_, index) => pr(100 + index, 10 * DAY, 'closed')));
      }
      if (parsed.pathname.endsWith('/check-runs')) return ok({ check_runs: [] });
      return ok([]);
    }) as unknown as typeof fetch;
    for (let cycle = 0; cycle < 2; cycle++)
      await github.pollWatchedRepo(
        github.repo.listPollingRepos(SESSION_EVENT_SCOPE)[0] ?? fail(),
        fetchImpl
      );
    expect(pullsPages).toEqual(['1', '1']);
    expect(topics).toEqual([]);
  });
});

function fail(): never {
  throw new Error('no sessions-scope watch');
}

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
