/**
 * Unit tests for pr-ready built-in validator.
 *
 * Covers:
 *   - missing PR URL
 *   - closed PR
 *   - unknown mergeability (retryable)
 *   - non-mergeable PR
 *   - unknown mergeStateStatus (retryable)
 *   - unsatisfied mergeStateStatus
 *   - unresolved review threads
 *   - successful handoff
 *   - gh CLI error (MCP error payload copy)
 *   - task-banner state distinction (block vs retryable_block)
 */

import { describe, test, expect } from 'bun:test';
import { createPrReadyValidator } from '../../../../src/lib/space/runtime/built-in-validators/pr-ready-validator';
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
    // During post-approval (task approved) the coder reports a blocker over the
    // pr_ready-hooked channel; the PR is by definition not ready, so the gate
    // must allow the report through without a gh call.
    const spawn = makeMockSpawn([]); // no gh calls expected — exemption short-circuits
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
    // The initial implementation handoff runs while the task is in-progress, so
    // a sender cannot spoof `merge_blocked` to bypass the gate and activate
    // Review with an unready PR. The validator proceeds and blocks on the real
    // state.
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
    // When the engine has no task-status provider, the exemption does not fire,
    // so a `merge_fix_pushed` reason cannot spoof the gate.
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
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    const previousGhRepo = process.env.GH_REPO;
    const previousGhConfigDir = process.env.GH_CONFIG_DIR;
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAppData = process.env.AppData;
    const previousHttpsProxy = process.env.HTTPS_PROXY;
    const previousHttpsProxyLower = process.env.https_proxy;
    const previousNoProxy = process.env.NO_PROXY;
    const previousSslCertFile = process.env.SSL_CERT_FILE;
    const previousGitSslCaInfo = process.env.GIT_SSL_CAINFO;
    process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret';
    process.env.GH_TOKEN = 'github-secret';
    process.env.GH_REPO = 'acme/corp';
    process.env.GH_CONFIG_DIR = '/tmp/gh-config';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    process.env.AppData = 'C:\\Users\\alice\\AppData\\Roaming';
    process.env.https_proxy = 'http://proxy.example:8080';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    process.env.SSL_CERT_FILE = '/tmp/corp-ca.pem';
    process.env.GIT_SSL_CAINFO = '/tmp/git-ca.pem';
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
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeToken;
      if (previousGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGhToken;
      if (previousGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previousGhRepo;
      if (previousGhConfigDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = previousGhConfigDir;
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      if (previousAppData === undefined) delete process.env.AppData;
      else process.env.AppData = previousAppData;
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousHttpsProxy;
      if (previousHttpsProxyLower === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = previousHttpsProxyLower;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousNoProxy;
      if (previousSslCertFile === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = previousSslCertFile;
      if (previousGitSslCaInfo === undefined) delete process.env.GIT_SSL_CAINFO;
      else process.env.GIT_SSL_CAINFO = previousGitSslCaInfo;
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
        // First call: gh pr view exits non-zero with rate-limit stderr
        stdout: '',
        stderr:
          'HTTP 403: rate limit exceeded (https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting)',
        exitCode: 1,
      },
      {
        // Follow-up probe: gh api /rate_limit succeeds and reports graphql reset
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
        // Probe fails too — should fall back to default backoff
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
        // gh pr view --json url for current branch — rate-limited
        stdout: '',
        stderr: 'HTTP 403: rate limit exceeded',
        exitCode: 1,
      },
      {
        // /rate_limit probe (current branch view uses the GraphQL PR finder)
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
        // reviewThreads query — rate-limited
        stdout: '',
        stderr: 'HTTP 403: rate limit exceeded',
        exitCode: 1,
      },
      {
        // /rate_limit probe
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
    // gh stderr from a token lacking permissions — bare 403 must not be
    // classified as a rate-limit, otherwise the workflow would back off
    // instead of surfacing the credential issue.
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
    // core.reset far in future, graphql.reset sooner — pick earliest.
    const graphqlReset = Math.floor((Date.now() + 75_000) / 1000);
    const coreReset = Math.floor((Date.now() + 300_000) / 1000);
    const spawn = makeMockSpawn([
      { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
      {
        // reviewThreads query rate-limited
        stdout: '',
        stderr: 'API rate limit exceeded',
        exitCode: 1,
      },
      {
        // /rate_limit probe — both windows present
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
    // Closer to the graphql reset (75s) than the core reset (300s).
    expect(retryAfterMs!).toBeLessThanOrEqual(75_000);
  });

  test('Enterprise host passed through to /rate_limit probe', async () => {
    const resetEpochSeconds = Math.floor((Date.now() + 120_000) / 1000);
    const calls: Array<{ cmd: string[] }> = [];
    const spawn = makeMockSpawn(
      [
        { stdout: JSON.stringify(VALID_PR_VIEW), stderr: '', exitCode: 0 },
        {
          // reviewThreads query for Enterprise PR rate-limited
          stdout: '',
          stderr: 'API rate limit exceeded',
          exitCode: 1,
        },
        {
          // /rate_limit probe
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
    // The /rate_limit probe call should include --hostname github.example.com
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
    // Should be retryable_block with RATE_LIMIT_MIN_BACKOFF_MS, not the result of a /rate_limit probe
    expect(result.type).toBe('retryable_block');
    const retryAfterMs = (result as { retryAfterMs?: number }).retryAfterMs;
    expect(retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
    // No /rate_limit probe should have been made (only 2 calls: pr view + review threads)
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
