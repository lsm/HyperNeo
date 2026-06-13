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
});
