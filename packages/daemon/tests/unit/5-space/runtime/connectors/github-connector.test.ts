/**
 * github connector op unit tests (epic #2299; promoted from the #2300 spike
 * in P2 #2302).
 *
 * Proves the L2 connector wraps `gh` correctly: each op returns the right
 * `ConnectorOutcome` for merged/open/conflict/UNKNOWN/rate-limit, review
 * threads compose into readiness, and reactions normalise + freshness-filter.
 * Mocked spawn — no real `gh` calls.
 */

import { describe, expect, test } from 'bun:test';
import { createGithubConnector } from '../../../../../src/lib/space/runtime/connectors/github-connector';
import type { ConnectorContext } from '../../../../../src/lib/space/runtime/connectors/connector';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../../src/lib/space/runtime/rate-limit-detector';

const PR_URL = 'https://github.com/acme/corp/pull/42';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** Build a mock spawn that returns a sequence of `{ stdout, stderr, exitCode }`. */
function mockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>
): typeof Bun.spawn {
  let i = 0;
  return ((cmd: string[]) => {
    // Disregard cmd; serve the next queued result.
    const result = results[i++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

/** Like mockSpawn, but also records each invocation's argv (for assert on
 *  pagination cursor binding etc.). */
function capturingMockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>,
  calls: string[][]
): typeof Bun.spawn {
  let i = 0;
  return ((cmd: string[]) => {
    calls.push(cmd);
    const result = results[i++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

function ctx(): ConnectorContext {
  return {
    workspacePath: '/tmp',
    params: {},
    rawParams: {},
    hookLocalState: {},
  };
}

const READY_PR_VIEW = {
  url: PR_URL,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
};

const EMPTY_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};

describe('github connector.getPr', () => {
  test('returns PR view payload on success', async () => {
    const conn = createGithubConnector(
      mockSpawn([{ stdout: JSON.stringify(READY_PR_VIEW), stderr: '', exitCode: 0 }])
    );
    const outcome = await conn.ops.getPr({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.state).toBe('OPEN');
      expect(outcome.data.mergeable).toBe('MERGEABLE');
    }
  });

  test('missing prUrl → terminal error', async () => {
    const conn = createGithubConnector(mockSpawn([]));
    const outcome = await conn.ops.getPr({}, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBeUndefined();
  });

  test('rate-limit stderr → retryable outcome', async () => {
    const conn = createGithubConnector(
      // First call: rate-limited pr view. Second call: the /rate_limit probe.
      mockSpawn([
        {
          stdout: '',
          stderr: 'HTTP 403: rate limit exceeded',
          exitCode: 1,
        },
        {
          stdout: JSON.stringify({ resources: { core: { reset: 0 } } }),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const outcome = await conn.ops.getPr({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true);
      // reset epoch 0 → computeRateLimitRetryMs floors at the minimum backoff.
      expect(outcome.retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    }
  });

  test('generic gh error → terminal error', async () => {
    const conn = createGithubConnector(
      mockSpawn([{ stdout: '', stderr: 'could not find pull request', exitCode: 1 }])
    );
    const outcome = await conn.ops.getPr({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable).toBeUndefined();
      expect(outcome.error).toContain('could not find pull request');
    }
  });
});

describe('github connector.getPrReadiness', () => {
  test('composes PR view + review threads into readiness', async () => {
    const conn = createGithubConnector(
      mockSpawn([
        { stdout: JSON.stringify(READY_PR_VIEW), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const outcome = await conn.ops.getPrReadiness({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.state).toBe('OPEN');
      expect(outcome.data.unresolvedThreadUrls).toEqual([]);
    }
  });

  test('surfaces unresolved thread urls', async () => {
    const threads = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 't1', isResolved: false, comments: { nodes: [{ url: 'https://g/c/1' }] } },
                { id: 't2', isResolved: true, comments: { nodes: [{ url: 'https://g/c/2' }] } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const conn = createGithubConnector(
      mockSpawn([
        { stdout: JSON.stringify(READY_PR_VIEW), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(threads), stderr: '', exitCode: 0 },
      ])
    );
    const outcome = await conn.ops.getPrReadiness({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.unresolvedThreadUrls).toEqual(['https://g/c/1']);
  });

  test('binds the cursor on paginated review-thread requests (>100 threads)', async () => {
    const page1 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 't1', isResolved: false, comments: { nodes: [{ url: 'https://g/c/1' }] } },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'YXJyYXljb25uZWN0aW9u' },
            },
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const calls: string[][] = [];
    const conn = createGithubConnector(
      capturingMockSpawn(
        [
          { stdout: JSON.stringify(READY_PR_VIEW), stderr: '', exitCode: 0 },
          { stdout: JSON.stringify(page1), stderr: '', exitCode: 0 },
          { stdout: JSON.stringify(page2), stderr: '', exitCode: 0 },
        ],
        calls
      )
    );
    const outcome = await conn.ops.getPrReadiness({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    // 3 gh calls: pr view, threads page 1, threads page 2.
    expect(calls).toHaveLength(3);
    const page2Args = calls[2]!.join(' ');
    // Page 2 must supply the cursor variable the query declares ($cursor).
    expect(page2Args).toContain('cursor=YXJyYXljb25uZWN0aW9u');
    // Page 1 must NOT carry a cursor binding.
    expect(calls[1]!.join(' ')).not.toContain('cursor=');
  });

  test('fails closed when neither input nor canonical URL parses', async () => {
    // Noncanonical selector accepted by `gh pr view`, but the returned canonical
    // URL is also unparseable — must NOT fabricate an empty thread list.
    const conn = createGithubConnector(
      mockSpawn([
        {
          stdout: JSON.stringify({ ...READY_PR_VIEW, url: 'not-a-canonical-url' }),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const outcome = await conn.ops.getPrReadiness({ prUrl: 'some-branch-selector' }, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('unable to parse PR URL');
  });

  test('falls back to the canonical URL from pr view for the threads query', async () => {
    // Input is a noncanonical selector; gh pr view returns the canonical URL,
    // which the threads query then uses.
    const conn = createGithubConnector(
      mockSpawn([
        { stdout: JSON.stringify({ ...READY_PR_VIEW, url: PR_URL }), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const outcome = await conn.ops.getPrReadiness({ prUrl: 'some-branch-selector' }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.unresolvedThreadUrls).toEqual([]);
  });
});

describe('github connector.getReactions', () => {
  const REACTIONS = [
    { user: { login: 'dependabot[bot]' }, content: 'eyes', created_at: '2026-08-02T11:00:00Z' },
    { user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-08-02T12:00:05Z' },
  ];

  test('normalises user.login/content/created_at into flat records', async () => {
    const conn = createGithubConnector(
      mockSpawn([{ stdout: JSON.stringify(REACTIONS), stderr: '', exitCode: 0 }])
    );
    const outcome = await conn.ops.getReactions({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const reactions = outcome.data.reactions as Array<Record<string, string>>;
      expect(reactions).toHaveLength(2);
      expect(reactions[1]).toEqual({
        login: 'codex[bot]',
        content: '+1',
        createdAt: '2026-08-02T12:00:05Z',
      });
    }
  });

  test('sinceIso filters out reactions older than the freshness anchor', async () => {
    const conn = createGithubConnector(
      mockSpawn([{ stdout: JSON.stringify(REACTIONS), stderr: '', exitCode: 0 }])
    );
    const outcome = await conn.ops.getReactions(
      { prUrl: PR_URL, sinceIso: '2026-08-02T12:00:00Z' },
      ctx()
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const reactions = outcome.data.reactions as Array<Record<string, string>>;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].login).toBe('codex[bot]');
    }
  });
});

describe('github connector.getCodexApproval', () => {
  const HEAD_COMMIT_AT = '2026-08-02T11:59:00Z';
  // getCodexApproval runs FIVE gh calls: REST pull metadata (head.sha), HEAD
  // COMMIT lookup (committer.date — covers normal pushes), issue EVENTS timeline
  // (referenced/head_ref_force_pushed with commit_id === headSha — covers
  // force-push-to-older), reactions, comments.
  const PR_VIEW_OK = {
    stdout: JSON.stringify({
      number: 42,
      head: { sha: 'headsha123' },
      html_url: PR_URL,
    }),
    stderr: '',
    exitCode: 0,
  };
  const HEAD_COMMIT_OK = {
    stdout: JSON.stringify({ commit: { committer: { date: HEAD_COMMIT_AT } } }),
    stderr: '',
    exitCode: 0,
  };
  const EVENTS_OK = {
    stdout: JSON.stringify([
      { event: 'referenced', commit_id: 'headsha123', created_at: HEAD_COMMIT_AT },
    ]),
    stderr: '',
    exitCode: 0,
  };
  const EMPTY_EVENTS = { stdout: '[]', stderr: '', exitCode: 0 };
  // `gh api --paginate --slurp` wraps every page's array in an outer array
  // (`[[...page1], [...page2]]`) — even a single page is `[[...items]]`.
  const EMPTY_SLURPED = { stdout: '[[]]', stderr: '', exitCode: 0 };
  const slurp = (items: unknown[]) => ({
    stdout: JSON.stringify([items]),
    stderr: '',
    exitCode: 0,
  });

  test('rejects a disallowed PR host before any gh call (SSRF protection)', async () => {
    const calls: string[][] = [];
    const conn = createGithubConnector(capturingMockSpawn([], calls));
    const outcome = await conn.ops.getCodexApproval(
      { prUrl: 'https://attacker.example/o/r/pull/1' },
      ctx()
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('not allowed for GitHub lookups');
    expect(calls).toHaveLength(0);
  });

  test('paginates reactions and comments with --paginate --slurp and flattens pages', async () => {
    const calls: string[][] = [];
    const conn = createGithubConnector(
      capturingMockSpawn(
        [PR_VIEW_OK, HEAD_COMMIT_OK, EVENTS_OK, EMPTY_SLURPED, EMPTY_SLURPED],
        calls
      )
    );
    const outcome = await conn.ops.getCodexApproval({ prUrl: PR_URL }, ctx());
    expect(outcome.ok).toBe(true);
    const reactionArgs = calls[3] ?? [];
    const commentArgs = calls[4] ?? [];
    expect(reactionArgs).toContain('--paginate');
    expect(reactionArgs).toContain('--slurp');
    expect(commentArgs).toContain('--paginate');
    expect(commentArgs).toContain('--slurp');
    if (outcome.ok) {
      expect((outcome.data as Record<string, unknown>).reactionCount).toBe(0);
    }
  });

  test('computes comment-on-head and fresh +1 from the fetched evidence', async () => {
    const conn = createGithubConnector(
      mockSpawn([
        PR_VIEW_OK,
        HEAD_COMMIT_OK,
        EVENTS_OK,
        slurp([
          { user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-08-02T12:00:05Z' },
        ]),
        slurp([
          {
            user: { login: 'codex[bot]' },
            body: 'reviewed headsha123',
            created_at: '2026-08-02T12:00:05Z',
          },
        ]),
      ])
    );
    const outcome = await conn.ops.getCodexApproval(
      { prUrl: PR_URL, sinceIso: '2026-08-02T12:00:00Z' },
      ctx()
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const data = outcome.data as Record<string, unknown>;
      expect(data.commentOnHead).toBe(true);
      expect(data.freshPlusOne).toBe(true);
      expect(data.headSha).toBe('headsha123');
    }
  });

  test('a +1 posted BEFORE the head commit is stale (not fresh for the current head)', async () => {
    const conn = createGithubConnector(
      mockSpawn([
        PR_VIEW_OK,
        HEAD_COMMIT_OK,
        EVENTS_OK,
        slurp([
          { user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-08-02T11:30:00Z' },
        ]),
        EMPTY_SLURPED,
      ])
    );
    const outcome = await conn.ops.getCodexApproval(
      { prUrl: PR_URL, sinceIso: '2026-08-02T11:00:00Z' },
      ctx()
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect((outcome.data as Record<string, unknown>).freshPlusOne).toBe(false);
    }
  });

  test('regression: no matching event + stale +1 is rejected (normal-push anchor)', async () => {
    // A NORMAL push (new commits) creates no `referenced` event with
    // commit_id === headSha → eventsPushedAt is undefined. The committer.date
    // anchor must still block a +1 from before the push. Without both anchors,
    // this exploit works: obtain a +1 on head A, push unreviewed code as head C
    // (no event), then the +1 for A passes because eventsPushedAt is undefined
    // and the anchor falls back to sinceIso.
    const conn = createGithubConnector(
      mockSpawn([
        PR_VIEW_OK,
        HEAD_COMMIT_OK, // committer.date = 11:59 (recent push)
        EMPTY_EVENTS, // no matching event → eventsPushedAt = undefined
        slurp([
          { user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-08-02T11:30:00Z' },
        ]),
        EMPTY_SLURPED,
      ])
    );
    const outcome = await conn.ops.getCodexApproval(
      { prUrl: PR_URL, sinceIso: '2026-08-02T11:00:00Z' },
      ctx()
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The +1 at 11:30 predates the head's committer.date (11:59), so it must
      // be rejected even though there is no events-API anchor.
      expect((outcome.data as Record<string, unknown>).freshPlusOne).toBe(false);
    }
  });
});
