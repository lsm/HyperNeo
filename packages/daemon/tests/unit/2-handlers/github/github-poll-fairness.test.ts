import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';

describe('GitHub polling fairness', () => {
  test('a 201-PR repo cannot spend the small repos shares, and its scan resumes after restart', async () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    const repos = ['a-heavy', 'b-phone', 'c-ops', 'd-research'];
    const events: ExternalEvent[] = [];
    let cycle = 0;
    let remaining = 40;
    const calls: string[] = [];
    const details = new Set<number>();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.github.com');
      calls.push(url.pathname);
      const repo = url.pathname.split('/')[3];
      const number = Number(url.pathname.split('/')[5]);
      let body: unknown = [];
      if (/\/pulls\/\d+$/.test(url.pathname)) {
        if (repo === 'a-heavy') details.add(number);
        body = { number, state: repo === 'a-heavy' ? 'closed' : 'open', mergeable: true };
      } else if (url.pathname.endsWith('/reviews') && repo !== 'a-heavy') {
        body = [
          {
            id: cycle * 1000 + repos.indexOf(repo),
            state: 'APPROVED',
            body: 'Synthetic approval',
            submitted_at: new Date().toISOString(),
            user: { login: 'reviewer' },
            html_url: `https://github.com/verify-test/${repo}/pull/162#pullrequestreview-${cycle}`,
          },
        ];
      }
      return Response.json(body, {
        headers: {
          'X-RateLimit-Remaining': String(--remaining),
          'X-RateLimit-Reset': '1',
        },
      });
    }) as typeof fetch;
    const options = {
      pollIntervalMs: 60_000,
      fetchImpl,
      subscribedPullRequests: ({ repo }: { repo: string }) =>
        repo === 'a-heavy' ? Array.from({ length: 201 }, (_, i) => i + 1) : [162],
    };
    let extension = new GitHubEventExtension(db, undefined, options);
    const start = async () =>
      extension.start({
        config,
        publisher: {
          publish: async (event) => {
            events.push(event);
          },
        },
        onSourceConfigChanged() {},
      });
    for (const repo of repos)
      extension.repo.upsertWatchedRepo({
        spaceId: 'test-space',
        owner: 'verify-test',
        repo,
        pollingEnabled: true,
      });
    const heavy = extension.repo.getWatchedRepo('test-space', 'verify-test', 'a-heavy')!;
    extension.repo.updatePollCursor(heavy.id, {
      lastSeenAt: 0,
      recentPullRequestHeadShas: Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [i + 1, `head-${i + 1}`])
      ),
    });
    await start();
    try {
      for (cycle = 1; cycle <= 80; cycle++) {
        calls.length = 0;
        events.length = 0;
        remaining = 40;
        await extension.pollOnce(fetchImpl);
        for (const repo of repos.slice(1)) {
          expect(calls.some((path) => path.includes(`/${repo}/pulls/162/reviews`))).toBe(true);
          expect(
            events.some(
              (event) => event.topic.includes(`/${repo}/`) && event.payload.state === 'APPROVED'
            )
          ).toBe(true);
          expect(
            extension.repo.getWatchedRepo('test-space', 'verify-test', repo)?.lastPollAt
          ).not.toBeNull();
        }
        expect(remaining).toBeGreaterThanOrEqual(10);
        if (cycle === 3) {
          await extension.stop();
          extension = new GitHubEventExtension(db, undefined, options);
          await start();
        }
      }
      expect(details.size).toBe(201);
    } finally {
      await extension.stop();
      db.close();
    }
  });
});
