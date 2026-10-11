import { afterEach, describe, expect, test } from 'bun:test';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import { SESSION_EVENT_SCOPE } from '../../../../src/lib/external-events/session-external-event-store';
import { githubRepoOfTopic } from '../../../../src/lib/external-events/subscription-operations';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

let extension: GitHubEventExtension | null = null;
afterEach(async () => {
  await extension?.stop();
  extension = null;
});

async function started(db: BunDatabase): Promise<GitHubEventExtension> {
  const created = new GitHubEventExtension(db, 'token', { getPollIntervalMs: () => 0 });
  extension = created;
  await created.start({
    publisher: { publish: async (event) => ({ outcome: 'published', eventId: event.id }) },
    config: new ExternalEventExtensionConfigStore(db),
    onSourceConfigChanged() {},
  });
  return created;
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
    expect(github.repo.listPollingRepos(SESSION_EVENT_SCOPE)).toHaveLength(1);
    expect(github.repo.listPollingRepos(SESSION_EVENT_SCOPE)[0]?.id).toBe(first?.id);
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
