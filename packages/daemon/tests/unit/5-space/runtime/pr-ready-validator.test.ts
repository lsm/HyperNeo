import { describe, test, expect } from 'bun:test';
import { createPrReadyValidator } from '../../../../src/lib/space/runtime/built-in-validators/pr-ready-validator';
import type { SpawnFn, SpawnProcess } from '../../../../src/lib/runtime-spawn';
import type { HookExecutorContext } from '../../../../src/lib/space/runtime/hook-executor';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../src/lib/space/runtime/rate-limit-detector';
import { _setStartupEnvBaselineForTesting } from '../../../../src/lib/spawn-env';

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
): SpawnFn {
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
      } as unknown as SpawnProcess;
    }
    const result = results[callIndex++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as SpawnProcess;
  }) as unknown as SpawnFn;
}

function makeContext(prUrl?: string): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'send_message',
    params: prUrl
      ? { target: 'Review', message: 'hi', data: { pr_url: prUrl } }
      : { target: 'Review', message: 'hi' },
    nodeId: 'node-1',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
  };
}

const VALID_PR_VIEW = {
  url: 'https://github.com/acme/corp/pull/42',
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
};

const EMPTY_THREADS = {
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

describe('pr-ready validator', () => {
  test('missing PR URL and no current branch PR → block', async () => {
    const validator = createPrReadyValidator(
      makeMockSpawn([{ stdout: '', stderr: 'no pull requests found', exitCode: 1 }])
    );
    const result = await validator(makeContext());
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('current-branch PR discovery failed');
    expect((result as { reason: string }).reason).toContain('no pull requests found');
  });

  test('missing PR URL falls back to current branch PR discovery', async () => {
    const spawn = makeMockSpawn([
      {
        stdout: JSON.stringify({ url: 'https://github.com/acme/corp/pull/42' }),
        stderr: '',
        exitCode: 0,
      },
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext());
    expect(result.type).toBe('patch_params');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/42'
    );
    expect((result as { patch?: Record<string, unknown> }).patch?.data).toEqual({
      pr_url: 'https://github.com/acme/corp/pull/42',
    });
  });

  test('closed PR → block with exact state', async () => {
    const prView = { ...VALID_PR_VIEW, state: 'CLOSED' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('state is CLOSED');
  });

  test('unknown mergeability → retryable_block', async () => {
    const prView = { ...VALID_PR_VIEW, mergeable: 'UNKNOWN' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('Waiting for GitHub mergeability');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
  });

  test('non-mergeable PR → block with exact reason', async () => {
    const prView = { ...VALID_PR_VIEW, mergeable: 'CONFLICTING' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not mergeable');
    expect((result as { reason: string }).reason).toContain('CONFLICTING');
  });

  test('unknown mergeStateStatus → retryable_block', async () => {
    const prView = { ...VALID_PR_VIEW, mergeStateStatus: 'UNKNOWN' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('Waiting for GitHub mergeability');
  });

  test('unsatisfied mergeStateStatus → block with exact reason', async () => {
    const prView = { ...VALID_PR_VIEW, mergeStateStatus: 'DIRTY' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('merge checks not satisfied');
    expect((result as { reason: string }).reason).toContain('DIRTY');
  });

  test('post-approval merge-blocker report is exempt ONLY while the task is approved', async () => {
    const spawn = makeMockSpawn([]);
    const validator = createPrReadyValidator(spawn);
    const ctx: HookExecutorContext = {
      ...makeContext('https://github.com/acme/corp/pull/42'),
      taskStatus: 'approved',
      hookLocalState: { pr_url: 'https://github.com/acme/corp/pull/42' },
      params: {
        target: 'Review',
        message: 'blocked',
        data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/42' },
      },
    };
    const result = await validator(ctx);
    expect(result.type).toBe('allow');
  });

  test('a spoofed merge reason during an in-progress handoff is NOT exempt', async () => {
    const prView = { ...VALID_PR_VIEW, mergeable: 'CONFLICTING' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const ctx: HookExecutorContext = {
      ...makeContext('https://github.com/acme/corp/pull/42'),
      taskStatus: 'in_progress',
      params: {
        target: 'Review',
        message: 'handoff',
        data: { reason: 'merge_blocked', pr_url: 'https://github.com/acme/corp/pull/42' },
      },
    };
    const result = await validator(ctx);
    expect(result.type).toBe('block');
  });

  test('undefined taskStatus (no provider) does NOT exempt — fails closed', async () => {
    const prView = { ...VALID_PR_VIEW, mergeable: 'CONFLICTING' };
    const spawn = makeMockSpawn([{ stdout: JSON.stringify(prView), stderr: '', exitCode: 0 }]);
    const validator = createPrReadyValidator(spawn);
    const ctx: HookExecutorContext = {
      ...makeContext('https://github.com/acme/corp/pull/42'),
      params: {
        target: 'Review',
        message: 'handoff',
        data: { reason: 'merge_fix_pushed', pr_url: 'https://github.com/acme/corp/pull/42' },
      },
    };
    const result = await validator(ctx);
    expect(result.type).toBe('block');
  });

  test('unresolved review threads → block with thread URLs', async () => {
    const threads = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  isResolved: false,
                  comments: {
                    nodes: [{ url: 'https://github.com/acme/corp/pull/42#discussion_r1' }],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify(threads), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('1 unresolved review conversation');
    expect((result as { reason: string }).reason).toContain(
      'https://github.com/acme/corp/pull/42#discussion_r1'
    );
  });

  test('successful handoff → allow with pr_url in data', async () => {
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/42'
    );
  });

  test('gh CLI error → block with stderr reason', async () => {
    const spawn = makeMockSpawn([{ stdout: '', stderr: 'gh: not authenticated', exitCode: 1 }]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not authenticated');
  });

  test('PR URL from rawParams when bounded params.data is truncated', async () => {
    const prView = { ...VALID_PR_VIEW, url: 'https://github.com/acme/corp/pull/77' };
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(prView), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrReadyValidator(spawn);
    const ctx: HookExecutorContext = {
      ...makeContext(),
      params: { target: 'Review', message: 'hi', data: '[truncated: large data field omitted]' },
      rawParams: {
        target: 'Review',
        message: 'hi',
        data: { pr_url: 'https://github.com/acme/corp/pull/77', extra: 'large payload' },
      },
    };
    const result = await validator(ctx);
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/77'
    );
  });

  test('gh subprocess receives restricted GitHub-only env', async () => {
    const calls: Array<{ cmd: string[]; options?: unknown }> = [];
    const spawn = makeMockSpawn(
      [
        { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ],
      calls
    );
    const previousBaselineSource: Record<string, string | undefined> = { ...process.env };
    _setStartupEnvBaselineForTesting({
      ...previousBaselineSource,
      ANTHROPIC_API_KEY: 'anthropic-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
      GH_TOKEN: 'github-secret',
      GH_REPO: 'acme/corp',
      GH_CONFIG_DIR: '/tmp/gh-config',
      XDG_CONFIG_HOME: '/tmp/xdg-config',
      AppData: 'C:\\Users\\alice\\AppData\\Roaming',
      https_proxy: 'http://proxy.example:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      SSL_CERT_FILE: '/tmp/corp-ca.pem',
      GIT_SSL_CAINFO: '/tmp/git-ca.pem',
    });
    try {
      const validator = createPrReadyValidator(spawn);
      const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
      expect(result.type).toBe('allow');
      const env = (calls[0].options as { env?: Record<string, string> }).env ?? {};
      expect(env.GH_TOKEN).toBe('github-secret');
      expect(env.GH_REPO).toBe('acme/corp');
      expect(env.GH_CONFIG_DIR).toBe('/tmp/gh-config');
      expect(env.XDG_CONFIG_HOME).toBe('/tmp/xdg-config');
      expect(env.AppData).toBe('C:\\Users\\alice\\AppData\\Roaming');
      expect(env.https_proxy).toBe('http://proxy.example:8080');
      expect(env.NO_PROXY).toBe('localhost,127.0.0.1');
      expect(env.SSL_CERT_FILE).toBe('/tmp/corp-ca.pem');
      expect(env.GIT_SSL_CAINFO).toBe('/tmp/git-ca.pem');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      _setStartupEnvBaselineForTesting(previousBaselineSource);
    }
  });

  test('PR URL from templateData when params.data missing', async () => {
    const prView = { ...VALID_PR_VIEW, url: 'https://github.com/acme/corp/pull/99' };
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(prView), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
    ]);
    const validator = createPrReadyValidator(spawn);
    const ctx: HookExecutorContext = {
      ...makeContext(),
      params: { target: 'Review', message: 'hi' },
      templateData: { pr_url: 'https://github.com/acme/corp/pull/99' },
    };
    const result = await validator(ctx);
    expect(result.type).toBe('patch_params');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(
      'https://github.com/acme/corp/pull/99'
    );
    expect((result as { patch?: Record<string, unknown> }).patch?.data).toEqual({
      pr_url: 'https://github.com/acme/corp/pull/99',
    });
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
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('rate limited');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  test('rate-limited gh pr view with failing probe → retryable_block with default backoff', async () => {
    const spawn = makeMockSpawn([
      {
        stdout: '',
        stderr: 'HTTP 429: Too Many Requests',
        exitCode: 1,
      },
      {
        stdout: '',
        stderr: 'network unreachable',
        exitCode: 1,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('rate limited');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(60_000);
  });

  test('rate-limited current-branch PR discovery → retryable_block', async () => {
    const resetEpochSeconds = Math.floor((Date.now() + 75_000) / 1000);
    const spawn = makeMockSpawn([
      {
        stdout: '',
        stderr: 'HTTP 403: rate limit exceeded',
        exitCode: 1,
      },
      {
        stdout: JSON.stringify({ resources: { graphql: { reset: resetEpochSeconds } } }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext());
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('rate limited');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  test('rate-limited review-threads query → retryable_block', async () => {
    const resetEpochSeconds = Math.floor((Date.now() + 120_000) / 1000);
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      {
        stdout: '',
        stderr: 'HTTP 403: rate limit exceeded',
        exitCode: 1,
      },
      {
        stdout: JSON.stringify({ resources: { core: { reset: resetEpochSeconds } } }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('rate limited');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  test('non-rate-limit gh error still hard-blocks (no retryable promotion)', async () => {
    const spawn = makeMockSpawn([
      {
        stdout: '',
        stderr: 'HTTP 404: Not Found',
        exitCode: 1,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('Not Found');
  });

  test('permission-error 403 without rate-limit text does NOT promote to retryable', async () => {
    const spawn = makeMockSpawn([
      {
        stdout: '',
        stderr: 'HTTP 403: Resource not accessible by integration',
        exitCode: 1,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('Resource not accessible');
  });

  test('graphql rate-limit probe reads both core and graphql reset windows', async () => {
    const graphqlReset = Math.floor((Date.now() + 75_000) / 1000);
    const coreReset = Math.floor((Date.now() + 300_000) / 1000);
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      {
        stdout: '',
        stderr: 'API rate limit exceeded',
        exitCode: 1,
      },
      {
        stdout: JSON.stringify({
          resources: {
            core: { reset: coreReset },
            graphql: { reset: graphqlReset },
          },
        }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    const retryAfterMs = (result as { retryAfterMs?: number }).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThanOrEqual(60_000);
    expect(retryAfterMs!).toBeLessThanOrEqual(75_000);
  });

  test('Enterprise host passed through to /rate_limit probe', async () => {
    const resetEpochSeconds = Math.floor((Date.now() + 120_000) / 1000);
    const calls: Array<{ cmd: string[] }> = [];
    const spawn = makeMockSpawn(
      [
        { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
        {
          stdout: '',
          stderr: 'API rate limit exceeded',
          exitCode: 1,
        },
        {
          stdout: JSON.stringify({ resources: { core: { reset: resetEpochSeconds } } }),
          stderr: '',
          exitCode: 0,
        },
      ],
      calls
    );
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.example.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    const rateLimitCall = calls.find((c) => c.cmd.includes('/rate_limit'));
    expect(rateLimitCall).toBeDefined();
    const hostnameIdx = rateLimitCall!.cmd.indexOf('--hostname');
    expect(hostnameIdx).toBeGreaterThan(-1);
    expect(rateLimitCall!.cmd[hostnameIdx + 1]).toBe('github.example.com');
  });

  test('secondary rate-limit error skips /rate_limit probe and returns min backoff', async () => {
    const calls: Array<{ cmd: string[]; options?: unknown }> = [];
    const spawn = makeMockSpawn(
      [
        { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
        {
          stdout: '',
          stderr: 'HTTP 403: You have exceeded a secondary rate limit',
          exitCode: 1,
        },
      ],
      calls
    );
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    const retryAfterMs = (result as { retryAfterMs?: number }).retryAfterMs;
    expect(retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    expect(calls.length).toBe(2);
  });

  test('graphql 200 errors payload rate-limit uses graphql reset window', async () => {
    const graphqlReset = Math.floor((Date.now() + 80_000) / 1000);
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] }),
        stderr: '',
        exitCode: 0,
      },
      {
        stdout: JSON.stringify({ resources: { graphql: { reset: graphqlReset } } }),
        stderr: '',
        exitCode: 0,
      },
    ]);
    const validator = createPrReadyValidator(spawn);
    const result = await validator(makeContext('https://github.com/acme/corp/pull/42'));
    expect(result.type).toBe('retryable_block');
    const retryAfterMs = (result as { retryAfterMs?: number }).retryAfterMs;
    expect(retryAfterMs).toBeGreaterThanOrEqual(60_000);
    expect(retryAfterMs!).toBeLessThanOrEqual(80_000);
  });
});
