/**
 * Unit tests for pr-merged built-in validator.
 *
 * Covers:
 *   - missing PR URL (no params, artifacts, or current-branch PR)
 *   - PR URL resolved from artifacts (camelCase + snake_case)
 *   - PR URL from templateData / params
 *   - merged PR → allow
 *   - unknown mergeability → retryable
 *   - merge conflict (CONFLICTING / DIRTY) → block routing back to coder
 *   - open but not merged, no conflict → block (merge first)
 *   - closed without merge → block
 *   - gh CLI error
 *   - rate-limit handling
 *   - restricted GitHub-only env
 */

import { describe, test, expect } from 'bun:test';
import { createPrMergedValidator } from '../../../../src/lib/space/runtime/built-in-validators/pr-merged-validator';
import type { HookExecutorContext } from '../../../../src/lib/space/runtime/hook-executor';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../src/lib/space/runtime/rate-limit-detector';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function makeMockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>,
  calls?: Array<{ cmd: string[]; options?: unknown }>
): typeof Bun.spawn {
  let callIndex = 0;
  return ((cmd: string[], options?: unknown) => {
    calls?.push({ cmd, options });
    if (cmd[0] === 'git' && cmd[1] === 'config') {
      return {
        stdout: streamFromString('git@github.com:acme/corp.git\n'),
        stderr: streamFromString(''),
        exited: Promise.resolve(0),
        pid: 12345,
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    }
    const result = results[callIndex++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

interface MakeContextOpts {
  prUrl?: string;
  artifacts?: HookExecutorContext['currentArtifacts'];
  templateData?: Record<string, unknown>;
}

function makeContext(opts: MakeContextOpts = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'mark_complete',
    params: opts.prUrl ? { goal_update: { data: { pr_url: opts.prUrl } } } : {},
    nodeId: 'node-review-1',
    nodeName: 'Review',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: opts.artifacts ?? [],
    permittedExternalLookups: ['github'],
    ...(opts.templateData ? { templateData: opts.templateData } : {}),
  };
}

const MERGED_PR_VIEW = {
  url: 'https://github.com/acme/corp/pull/42',
  state: 'MERGED',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
};

describe('pr-merged validator', () => {
  test('missing PR URL and no artifacts and no current branch PR → block', async () => {
    const validator = createPrMergedValidator(
      makeMockSpawn([{ stdout: '', stderr: 'no pull requests found', exitCode: 1 }])
    );
    const result = await validator(makeContext());
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('no PR URL resolved to verify merge');
    expect((result as { reason: string }).reason).toContain('current-branch PR discovery failed');
    expect((result as { reason: string }).reason).toContain('no pull requests found');
  });

  test('PR URL resolved from artifacts (camelCase prUrl) → merged → allow', async () => {
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(MERGED_PR_VIEW), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/42'
    );
    expect((result as { data?: Record<string, unknown> }).data?.merged).toBe(true);
  });

  test('PR URL resolved from artifacts (snake_case pr_url)', async () => {
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(MERGED_PR_VIEW), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'progress', data: { pr_url: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('allow');
  });

  test('artifact lookup prefers most-recent first (first hit wins)', async () => {
    // currentArtifacts is sorted most-recent-first by the hook engine; the
    // first artifact carrying a PR URL should win.
    const spawn = makeMockSpawn([
      {
        stdout: JSON.stringify({ ...MERGED_PR_VIEW, url: 'https://github.com/acme/corp/pull/99' }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [
          { type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/99' } },
          { type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } },
        ],
      })
    );
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/99'
    );
  });

  test('PR URL from templateData → merged → allow', async () => {
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(MERGED_PR_VIEW), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({ templateData: { pr_url: 'https://github.com/acme/corp/pull/42' } })
    );
    expect(result.type).toBe('allow');
  });

  test('unknown mergeability → retryable_block', async () => {
    const prView = {
      ...MERGED_PR_VIEW,
      state: 'OPEN',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
    };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('Waiting for GitHub mergeability');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
  });

  test('merge conflict (mergeable CONFLICTING) → block routing back to coder', async () => {
    const prView = {
      ...MERGED_PR_VIEW,
      state: 'OPEN',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'BLOCKED',
    };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('unresolved merge conflicts');
    expect(reason).toContain('CONFLICTING');
    expect(reason).toContain('Route the conflict back');
    expect(reason).toContain('coder');
  });

  test('merge conflict (mergeStateStatus DIRTY) → block routing back to coder', async () => {
    const prView = {
      ...MERGED_PR_VIEW,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'DIRTY',
    };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('unresolved merge conflicts');
    expect(reason).toContain('DIRTY');
    expect(reason).toContain('Route the conflict back');
  });

  test('open but not merged and no conflict → block (merge first)', async () => {
    const prView = {
      ...MERGED_PR_VIEW,
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('PR is not merged');
    expect(reason).toContain('Merge the PR');
    expect(reason).toContain('gh pr merge');
  });

  test('closed without merge → block', async () => {
    const prView = {
      ...MERGED_PR_VIEW,
      state: 'CLOSED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('CLOSED without being merged');
  });

  test('gh CLI error → block with stderr reason', async () => {
    const spawn = makeMockSpawn([{ stdout: '', stderr: 'gh: not authenticated', exitCode: 1 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not authenticated');
  });

  test('rate-limited gh pr view → retryable_block with backoff from /rate_limit', async () => {
    const resetEpochSeconds = Math.floor((Date.now() + 90_000) / 1000);
    const spawn = makeMockSpawn([
      {
        stdout: '',
        stderr:
          'HTTP 403: rate limit exceeded (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)',
        exitCode: 1,
      },
      {
        stdout: JSON.stringify({ resources: { graphql: { reset: resetEpochSeconds } } }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('rate limited');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  test('secondary rate-limit error skips probe and returns min backoff', async () => {
    const calls: Array<{ cmd: string[] }> = [];
    const spawn = makeMockSpawn(
      [{ stdout: '', stderr: 'HTTP 403: You have exceeded a secondary rate limit', exitCode: 1 }],
      calls
    );
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    // Only one gh call (the pr view); no /rate_limit probe for secondary limits.
    expect(calls.filter((c) => c.cmd[0] === 'gh').length).toBe(1);
  });

  test('non-rate-limit gh error hard-blocks (no retryable promotion)', async () => {
    const spawn = makeMockSpawn([{ stdout: '', stderr: 'HTTP 404: Not Found', exitCode: 1 }]);
    const validator = createPrMergedValidator(spawn);
    const result = await validator(
      makeContext({
        artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('Not Found');
  });

  test('gh subprocess receives restricted GitHub-only env', async () => {
    const calls: Array<{ cmd: string[]; options?: unknown }> = [];
    const spawn = makeMockSpawn(
      [{ stdout: JSON.stringify(MERGED_PR_VIEW), stderr: '', exitCode: 0 }],
      calls
    );
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret';
    process.env.GH_TOKEN = 'github-secret';
    try {
      const validator = createPrMergedValidator(spawn);
      const result = await validator(
        makeContext({
          artifacts: [{ type: 'result', data: { prUrl: 'https://github.com/acme/corp/pull/42' } }],
        })
      );
      expect(result.type).toBe('allow');
      const env = (calls[0].options as { env?: Record<string, string> }).env ?? {};
      expect(env.GH_TOKEN).toBe('github-secret');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeToken;
      if (previousGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
    }
  });
});
