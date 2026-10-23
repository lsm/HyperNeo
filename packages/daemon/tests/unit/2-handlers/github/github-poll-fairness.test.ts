import { describe, expect, test } from 'bun:test';
import { CodingPollFactsRepository } from '../../../../src/lib/neo/packs/coding/poll-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';

function collector(db: Database) {
  createCodingPackTables(db);
  const facts = new CodingPollFactsRepository(db);
  return facts.collect.bind(facts);
}

describe('GitHub polling fairness', () => {
  for (const stage of [4, 5, 6]) {
    test(`a completing stage-${stage} resume preserves events on a newly discovered earlier PR`, async () => {
      const db = new Database(':memory:');
      createTables(db);
      runMigrations(db, () => {});
      const config = new ExternalEventExtensionConfigStore(db);
      await config.setGlobalConfig('github', {
        source: 'github',
        globallyEnabled: true,
        capabilities: { polling: true },
      });
      const events: ExternalEvent[] = [];
      const committed = Date.parse('2026-01-01T00:00:00Z');
      const occurred = '2026-01-01T00:01:00Z';
      const updated = '2026-01-01T00:02:00Z';
      const row = {
        id: 30,
        number: 3,
        state: 'open',
        title: 'New PR',
        updated_at: updated,
        head: { sha: 'new-head' },
        user: { login: 'human' },
      };
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        let body: unknown = [];
        if (url.pathname.endsWith('/pulls')) body = [row];
        if (/\/pulls\/\d+$/.test(url.pathname))
          body = { ...row, number: Number(url.pathname.split('/').at(-1)), mergeable: true };
        if (url.pathname.endsWith('/pulls/3/reviews'))
          body = [
            { id: 301, state: 'APPROVED', submitted_at: occurred, user: { login: 'reviewer' } },
          ];
        if (url.pathname.endsWith('/issues/3/reactions'))
          body = [{ id: 302, content: '+1', created_at: occurred, user: { login: 'human' } }];
        if (url.pathname.endsWith('/check-runs'))
          body = {
            check_runs: [
              {
                id: 303,
                name: 'build',
                status: 'completed',
                conclusion: 'failure',
                completed_at: occurred,
                app: { id: 1 },
                pull_requests: [{ number: 3 }],
              },
            ],
          };
        return Response.json(body, { headers: { 'X-RateLimit-Remaining': '5000' } });
      }) as typeof fetch;
      const extension = new GitHubEventExtension(db, undefined, {
        collectPollPage: collector(db),
        pollIntervalMs: 60_000,
        fetchImpl,
      });
      const repo = extension.repo.upsertWatchedRepo({
        spaceId: 'test-space',
        owner: 'verify-test',
        repo: 'one',
        pollingEnabled: true,
      });
      extension.repo.updatePollCursorJson(repo.id, {
        lastSeenAt: committed,
        recentPullRequestNumbers: [2],
        pollResume: { stage, item: '2' },
      });
      await extension.start({
        config,
        publisher: {
          publish: async (event) => {
            events.push(event);
          },
        },
        onSourceConfigChanged() {},
      });
      try {
        await extension.pollOnce(fetchImpl);
        await extension.pollOnce(fetchImpl);
        await extension.pollOnce(fetchImpl);
        expect(events.filter((event) => event.payload.reviewId === '301')).toHaveLength(1);
        expect(events.filter((event) => event.payload.type === 'reaction')).toHaveLength(1);
        expect(events.some((event) => event.payload.checkRunId === 303)).toBe(true);
        expect(
          extension.repo.getWatchedRepo('test-space', 'verify-test', 'one')?.pollCursor?.lastSeenAt
        ).toBe(Date.parse(updated));
      } finally {
        await extension.stop();
        db.close();
      }
    });
  }

  test('a one-request share resumes check pages without reviving superseded failures', async () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    const events: ExternalEvent[] = [];
    const pages: number[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      let body: unknown = [];
      if (url.pathname.endsWith('/check-runs')) {
        const page = Number(url.searchParams.get('page'));
        pages.push(page);
        const row = (id: number, name: string, conclusion: string) => ({
          id,
          name,
          conclusion,
          status: 'completed',
          completed_at: new Date().toISOString(),
          app: { id: 1 },
          pull_requests: [{ number: 7 }],
        });
        body = {
          check_runs:
            page === 1
              ? Array.from({ length: 100 }, (_, i) =>
                  row(i + 1, i === 0 ? 'build' : `check-${i}`, 'success')
                )
              : [row(200, 'build', 'failure'), row(201, 'another-build', 'failure')],
        };
      }
      return Response.json(body, {
        headers: { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset': '1' },
      });
    }) as typeof fetch;
    const extension = new GitHubEventExtension(db, undefined, {
      collectPollPage: collector(db),
      pollIntervalMs: 60_000,
      fetchImpl,
      subscribedPullRequests: () => [7],
    });
    const repo = extension.repo.upsertWatchedRepo({
      spaceId: 'test-space',
      owner: 'verify-test',
      repo: 'one',
      pollingEnabled: true,
    });
    extension.repo.updatePollCursor(repo.id, {
      lastSeenAt: 0,
      recentPullRequestNumbers: [7],
      recentPullRequestHeadShas: { 7: 'head' },
    });
    await extension.start({
      config,
      publisher: {
        publish: async (event) => {
          events.push(event);
        },
      },
      onSourceConfigChanged() {},
    });
    try {
      for (let cycle = 0; cycle < 8; cycle++) await extension.pollOnce(fetchImpl);
      expect(pages).toEqual([1, 2]);
      expect(events.some((event) => event.payload.checkRunId === 200)).toBe(false);
      expect(events.some((event) => event.payload.checkRunId === 201)).toBe(true);
    } finally {
      await extension.stop();
      db.close();
    }
  });

  test('review pagination resumes across extension restart and still delivers the later verdict', async () => {
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    const pages: number[] = [],
      events: ExternalEvent[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      let body: unknown = [];
      if (/\/pulls\/7$/.test(url.pathname)) body = { number: 7, state: 'open', mergeable: true };
      if (url.pathname.endsWith('/reviews')) {
        const page = Number(url.searchParams.get('page') ?? '1');
        pages.push(page);
        body = Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({
          id: page * 1000 + i,
          state: 'APPROVED',
          user: { login: 'reviewer' },
          submitted_at: new Date().toISOString(),
        }));
      }
      return Response.json(body, {
        headers: { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset': '1' },
      });
    }) as typeof fetch;
    const options = {
      collectPollPage: collector(db),
      pollIntervalMs: 60_000,
      fetchImpl,
      subscribedPullRequests: () => [7],
    };
    let extension = new GitHubEventExtension(db, undefined, options);
    extension.repo.upsertWatchedRepo({
      spaceId: 'test-space',
      owner: 'verify-test',
      repo: 'one',
      pollingEnabled: true,
    });
    const start = () =>
      extension.start({
        config,
        publisher: {
          publish: async (event) => {
            events.push(event);
          },
        },
        onSourceConfigChanged() {},
      });
    await start();
    try {
      for (let cycle = 0; cycle < 15 && pages.length < 1; cycle++)
        await extension.pollOnce(fetchImpl);
      await extension.stop();
      extension = new GitHubEventExtension(db, undefined, options);
      await start();
      for (let cycle = 0; cycle < 5 && pages.length < 2; cycle++)
        await extension.pollOnce(fetchImpl);
      expect(pages).toEqual([1, 2]);
      expect(events.filter((event) => event.payload.reviewId === '2000')).toHaveLength(1);
    } finally {
      await extension.stop();
      db.close();
    }
  });

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
      collectPollPage: collector(db),
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
    extension.repo.updatePollCursorJson(heavy.id, {
      lastSeenAt: 0,
      recentPullRequestHeadShas: Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [i + 1, `head-${i + 1}`])
      ),
    });
    await start();
    try {
      for (cycle = 1; cycle <= 120; cycle++) {
        calls.length = 0;
        events.length = 0;
        remaining = 40;
        await extension.pollOnce(fetchImpl);
        if (cycle === 1) expect(calls[0]).toContain('/a-heavy/');
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
