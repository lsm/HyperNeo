import { describe, expect, test } from 'bun:test';
import { createGithubConnector } from '../../../../../src/lib/space/runtime/connectors/github-connector';
import type { SpawnFn, SpawnProcess } from '../../../../../src/lib/runtime-spawn';
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

function mockSpawn(results: Array<{ stdout: string; stderr: string; exitCode: number }>): SpawnFn {
  let i = 0;
  return ((cmd: string[]) => {
    const result = results[i++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as SpawnProcess;
  }) as unknown as SpawnFn;
}

function capturingMockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>,
  calls: string[][]
): SpawnFn {
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
    } as unknown as SpawnProcess;
  }) as unknown as SpawnFn;
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

  test('rejects absolute PR URLs on untrusted hosts before spawning gh', async () => {
    const calls: string[][] = [];
    const conn = createGithubConnector(capturingMockSpawn([], calls));
    const outcome = await conn.ops.getPr(
      { prUrl: 'https://attacker.example/acme/corp/pull/42' },
      ctx()
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('not allowed for GitHub lookups');
    expect(calls).toEqual([]);
  });

  test('missing prUrl → terminal error', async () => {
    const conn = createGithubConnector(mockSpawn([]));
    const outcome = await conn.ops.getPr({}, ctx());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBeUndefined();
  });

  test('rate-limit stderr → retryable outcome', async () => {
    const conn = createGithubConnector(
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
    expect(calls).toHaveLength(3);
    const page2Args = calls[2]!.join(' ');
    expect(page2Args).toContain('cursor=YXJyYXljb25uZWN0aW9u');
    expect(calls[1]!.join(' ')).not.toContain('cursor=');
  });

  test('fails closed when neither input nor canonical URL parses', async () => {
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
