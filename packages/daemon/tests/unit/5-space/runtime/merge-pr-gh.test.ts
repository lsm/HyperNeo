/**
 * Tests for the production gh-backed {@link MergePrDeps} (task #866).
 *
 * Mocks `Bun.spawn` to script `gh pr view` + `gh api graphql` responses and
 * asserts the fetcher:
 *   - issues the FIRST GraphQL page WITHOUT a cursor and subsequent pages WITH
 *     it (mirrors the pr-ready-validator pagination convention);
 *   - paginates reviews and review threads across pages;
 *   - fails closed when a page reports hasNextPage without an endCursor.
 *
 * No network.
 */

import { describe, test, expect } from 'bun:test';
import { buildMergePrDeps } from '../../../../src/lib/space/runtime/merge-pr-gh';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

interface ScriptedProc {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  pid: number;
  kill(): void;
}

function proc(stdout: string, exitCode = 0): ScriptedProc {
  return {
    stdout: streamFromString(stdout),
    stderr: streamFromString(''),
    exited: Promise.resolve(exitCode),
    pid: 1,
    kill() {},
  };
}

const VIEW_JSON = {
  state: 'OPEN',
  baseRefName: 'dev',
  headRefOid: 'abcdef',
  headRefName: 'feature/x',
  isCrossRepository: false,
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  author: { login: 'author' },
  statusCheckRollup: [],
};

/**
 * Build a mock spawn that scripts graphql pages. `reviews`/`threads` are arrays
 * of { nodes, hasNextPage, endCursor? } pages. Records every graphql call's
 * query+cursor so the test can assert the first page omits the cursor.
 */
function mockSpawn(opts: {
  reviewsPages: Array<{ nodes: unknown[]; hasNextPage: boolean; endCursor?: string }>;
  threadsPages: Array<{ nodes: unknown[]; hasNextPage: boolean; endCursor?: string }>;
}) {
  const graphqlCalls: Array<{ query: string; cursor: string | null }> = [];
  let reviewPage = 0;
  let threadPage = 0;

  return {
    calls: graphqlCalls,
    spawn: ((cmd: string[]) => {
      const joined = cmd.join(' ');
      if (joined.startsWith('gh pr view')) {
        return proc(JSON.stringify(VIEW_JSON));
      }
      if (joined.startsWith('gh api graphql')) {
        const queryArg = cmd.find((a) => a.startsWith('query=')) ?? '';
        const cursorArg = cmd.find((a) => a.startsWith('cursor='));
        const query = queryArg.slice('query='.length);
        const cursor = cursorArg ? cursorArg.slice('cursor='.length) : null;
        graphqlCalls.push({ query, cursor });

        if (query.includes('reviews(first')) {
          const page = opts.reviewsPages[Math.min(reviewPage, opts.reviewsPages.length - 1)];
          reviewPage += 1;
          return proc(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviews: {
                      nodes: page.nodes,
                      pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
                    },
                  },
                },
              },
            })
          );
        }
        const page = opts.threadsPages[Math.min(threadPage, opts.threadsPages.length - 1)];
        threadPage += 1;
        return proc(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: page.nodes,
                    pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
                  },
                },
              },
            },
          })
        );
      }
      return proc('', 1);
    }) as unknown as typeof Bun.spawn,
  };
}

describe('buildMergePrDeps.fetchSnapshot — pagination + fail-closed', () => {
  test('first GraphQL page omits the cursor; later pages pass it (pr-ready-validator convention)', async () => {
    const mock = mockSpawn({
      reviewsPages: [
        { nodes: [{ state: 'APPROVED', commit: { oid: 'abcdef' } }], hasNextPage: false },
      ],
      threadsPages: [{ nodes: [{ isResolved: true }], hasNextPage: false }],
    });
    const deps = buildMergePrDeps({ spawn: mock.spawn, cwd: '/tmp' });
    const snap = await deps.fetchSnapshot('https://github.com/acme/repo/pull/42');

    // First reviews page and first threads page must have cursor === null.
    const firstReviews = mock.calls.find((c) => c.query.includes('reviews(first'));
    const firstThreads = mock.calls.find((c) => c.query.includes('reviewThreads(first'));
    expect(firstReviews?.cursor).toBeNull();
    expect(firstThreads?.cursor).toBeNull();
    // And the first-page queries must not declare $cursor at all.
    expect(firstReviews?.query).not.toContain('$cursor');
    expect(firstThreads?.query).not.toContain('$cursor');

    expect(snap.fetchErrors).toEqual([]);
    expect(snap.headRefOid).toBe('abcdef');
    expect(snap.prAuthorLogin).toBe('author');
    expect(snap.reviews).toHaveLength(1);
  });

  test('paginates reviews and threads across pages', async () => {
    const mock = mockSpawn({
      reviewsPages: [
        {
          nodes: [{ state: 'COMMENTED', commit: { oid: 'abcdef' } }],
          hasNextPage: true,
          endCursor: 'rev-1',
        },
        {
          nodes: [
            { state: 'APPROVED', commit: { oid: 'abcdef' }, submittedAt: '2026-01-02T00:00:00Z' },
          ],
          hasNextPage: false,
        },
      ],
      threadsPages: [
        {
          nodes: [{ isResolved: false }, { isResolved: true }],
          hasNextPage: true,
          endCursor: 'thr-1',
        },
        { nodes: [{ isResolved: false }], hasNextPage: false },
      ],
    });
    const deps = buildMergePrDeps({ spawn: mock.spawn, cwd: '/tmp' });
    const snap = await deps.fetchSnapshot('https://github.com/acme/repo/pull/42');

    expect(snap.fetchErrors).toEqual([]);
    expect(snap.reviews).toHaveLength(2);
    expect(snap.unresolvedThreadCount).toBe(2); // 1 on page 1, 1 on page 2
    // The second page of each must carry the cursor from page 1.
    const reviewsCalls = mock.calls.filter((c) => c.query.includes('reviews(first'));
    const threadsCalls = mock.calls.filter((c) => c.query.includes('reviewThreads(first'));
    expect(reviewsCalls[1]?.cursor).toBe('rev-1');
    expect(threadsCalls[1]?.cursor).toBe('thr-1');
  });

  test('fails closed when a page reports hasNextPage without an endCursor', async () => {
    const mock = mockSpawn({
      reviewsPages: [{ nodes: [], hasNextPage: false }],
      threadsPages: [{ nodes: [{ isResolved: false }], hasNextPage: true /* no endCursor */ }],
    });
    const deps = buildMergePrDeps({ spawn: mock.spawn, cwd: '/tmp' });
    const snap = await deps.fetchSnapshot('https://github.com/acme/repo/pull/42');

    expect(snap.fetchErrors.some((e) => e.includes('pagination incomplete'))).toBe(true);
  });
});
