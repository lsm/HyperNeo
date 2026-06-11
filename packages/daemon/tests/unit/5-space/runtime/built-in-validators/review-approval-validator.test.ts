/**
 * Unit tests for reviewApprovalValidator.
 *
 * Covers: vote extraction, threshold activation, concurrent vote deep-merge,
 * rejection reset, codex timeout, and boolean/map vote styles.
 */

import { describe, test, expect } from 'bun:test';
import { reviewApprovalValidator } from '../../../../../src/lib/space/runtime/built-in-validators/review-approval-validator';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';

function makeCtx(overrides: Partial<HookExecutorContext> = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'send_message',
    params: {},
    nodeId: 'node-review',
    nodeName: 'Review',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: [],
    ...overrides,
  };
}

describe('reviewApprovalValidator', () => {
  test('retry-blocks and records vote when threshold not met', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved' } } },
      templateData: { threshold: 2 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('1/2');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: { arch: 'approved' },
    });
  });

  test('allows when threshold is met', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { sec: 'approved' } } },
      hookLocalState: { approvals: { arch: 'approved' } },
      templateData: { threshold: 2 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('2/2');
  });

  test('deep-merges votes without overwriting prior entries', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { ux: 'approved' } } },
      hookLocalState: { approvals: { arch: 'approved', sec: 'approved' } },
      templateData: { threshold: 4 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?.approvals).toEqual({
      arch: 'approved',
      sec: 'approved',
      ux: 'approved',
    });
  });

  test('resets state on rejection when resetOnRejection is true', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'rejected' } } },
      hookLocalState: { approvals: { sec: 'approved', ux: 'approved' } },
      templateData: { threshold: 4, resetOnRejection: true },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('rejected');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: null,
      _codex_started_at: null,
      _codex_head_sha: null,
      _pr_url: null,
    });
  });

  test('does not reset on rejection when resetOnRejection is false', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'rejected' } } },
      hookLocalState: { approvals: { sec: 'approved' } },
      templateData: { threshold: 4, resetOnRejection: false },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?.approvals).toEqual({
      arch: 'rejected',
      sec: 'approved',
    });
  });

  test('handles boolean-style approval', async () => {
    const ctx = makeCtx({
      params: { data: { approved: true } },
      templateData: { threshold: 1 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('1/1');
  });

  test('counts only matching vote values', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved', sec: 'pending' } } },
      hookLocalState: { approvals: { ux: 'approved' } },
      templateData: { threshold: 3 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('2/3');
  });

  test('uses templateData defaults when unspecified', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { arch: 'approved' } } },
      // no templateData → threshold 1, voteKey 'approvals', voteMatch 'approved'
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
  });

  test('starts codex timeout on first threshold hit', async () => {
    const ctx = makeCtx({
      params: { data: { approved: true } },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('codex');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_started_at).toBeTypeOf('number');
  });

  test('allows after codex timeout elapsed', async () => {
    const now = Date.now();
    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { _codex_started_at: now - 700_000 }, // 700s ago, timeout 600s
      templateData: { threshold: 1, requireCodex: true, codexTimeoutMs: 600_000 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('timed out');
  });

  test('accepts codex approval already posted for current head before threshold vote', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                commits: { nodes: [{ commit: { committedDate: '2025-12-31T00:00:00Z' } }] },
                reactions: {
                  nodes: [
                    {
                      user: { login: 'codex[bot]' },
                      content: 'THUMBS_UP',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                  ],
                },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      hookLocalState: {},
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('codex approval');
  });

  test('rejects first-cycle codex reaction older than current head', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                commits: { nodes: [{ commit: { committedDate: '2026-01-02T00:00:00Z' } }] },
                reactions: {
                  nodes: [
                    {
                      user: { login: 'codex[bot]' },
                      content: 'THUMBS_UP',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                  ],
                },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      hookLocalState: {},
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('codex');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_started_at).toBeTypeOf('number');
    expect(state?._codex_head_sha).toBe('abc123');
  });

  test('allows immediately when codex already approved', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                reactions: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      reactions: {
                        nodes: [
                          {
                            user: { login: 'codex[bot]' },
                            content: 'THUMBS_UP',
                            createdAt: '2999-01-01T00:00:00Z',
                          },
                        ],
                      },
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      hookLocalState: { _codex_head_sha: 'abc123', _codex_started_at: Date.now() - 10_000 },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('codex approval');
  });

  test('finds pr_url in artifacts when not in message data', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                reactions: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      reactions: {
                        nodes: [
                          {
                            user: { login: 'codex[bot]' },
                            content: 'THUMBS_UP',
                            createdAt: '2999-01-01T00:00:00Z',
                          },
                        ],
                      },
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { _codex_head_sha: 'abc123', _codex_started_at: Date.now() - 10_000 },
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'result',
          key: 'cycle-0',
          data: { pr_url: 'https://github.com/test/repo/pull/42' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('codex approval');
  });

  test('starts codex timeout on API error so timeout can eventually allow', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () =>
      ({
        ok: false,
        status: 500,
      }) as Response;

    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('retryable_block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_started_at).toBeTypeOf('number');
  });

  test('persists partial votes even when retry-blocked', async () => {
    const ctx = makeCtx({
      params: { data: { approvals: { a: 'approved' } } },
      hookLocalState: {},
      templateData: { threshold: 3 },
    });

    const result = await reviewApprovalValidator(ctx);

    expect(result.type).toBe('retryable_block');
    expect((result as { state?: Record<string, unknown> }).state).toEqual({
      approvals: { a: 'approved' },
    });
  });

  test('resets codex timer when PR head SHA changes', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'new-sha-456',
                reactions: {
                  nodes: [
                    {
                      user: { login: 'codex[bot]' },
                      content: 'THUMBS_UP',
                      createdAt: '2999-01-01T00:00:00Z',
                    },
                  ],
                },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      hookLocalState: {
        _codex_started_at: Date.now() - 10_000,
        _codex_head_sha: 'old-sha-123',
      },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('retryable_block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_head_sha).toBe('new-sha-456');
    expect(state?._codex_started_at).toBeTypeOf('number');
    expect((result as { reason: string }).reason).toContain('New PR revision');
  });

  test('uses enterprise GraphQL endpoint for non-github.com hosts', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    const originalGhHost = process.env.GH_HOST;
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GH_HOST = 'github.enterprise.com';
    let requestedUrl = '';
    globalThis.fetch = async (url, init) => {
      requestedUrl = url as string;
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'ent-sha-789',
                reactions: { nodes: [] },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { approved: true, pr_url: 'https://github.enterprise.com/org/repo/pull/42' },
      },
      hookLocalState: { _codex_head_sha: 'ent-sha-789', _codex_started_at: Date.now() - 10_000 },
      templateData: { threshold: 1, requireCodex: true },
    });

    await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;
    process.env.GH_HOST = originalGhHost;

    expect(requestedUrl).toBe('https://github.enterprise.com/api/graphql');
  });

  test('finds pr_url in gate data when not in message data or artifacts', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                reactions: { nodes: [] },
                comments: {
                  nodes: [
                    {
                      reactions: {
                        nodes: [
                          {
                            user: { login: 'codex[bot]' },
                            content: 'THUMBS_UP',
                            createdAt: '2999-01-01T00:00:00Z',
                          },
                        ],
                      },
                    },
                  ],
                },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { _codex_head_sha: 'abc123', _codex_started_at: Date.now() - 10_000 },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/42' },
          updatedAt: Date.now(),
        },
      ],
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('codex approval');
  });

  test('records head SHA and blocks after reset when stale codex exists', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'sha-after-reset',
                reactions: {
                  nodes: [
                    {
                      user: { login: 'codex[bot]' },
                      content: 'THUMBS_UP',
                      createdAt: '2999-01-01T00:00:00Z',
                    },
                  ],
                },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    // After reset, _codex_head_sha is null (no storedHeadSha)
    const ctx = makeCtx({
      params: { data: { approved: true, pr_url: 'https://github.com/test/repo/pull/42' } },
      hookLocalState: { _codex_started_at: null, _codex_head_sha: null },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    // Should NOT allow even though codex thumbs-up exists — SHA was reset
    expect(result.type).toBe('retryable_block');
    const state = (result as { state?: Record<string, unknown> }).state;
    expect(state?._codex_head_sha).toBe('sha-after-reset');
    expect((result as { reason: string }).reason).toContain('reset');
  });

  test('rejects untrusted host for codex lookup', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: false, status: 403 } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { approved: true, pr_url: 'https://attacker.example/org/repo/pull/1' },
      },
      hookLocalState: { _codex_head_sha: 'abc123', _codex_started_at: Date.now() - 10_000 },
      templateData: { threshold: 1, requireCodex: true },
    });

    const result = await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    // Should NOT make any API call and should block
    expect(fetchCalled).toBe(false);
    expect(result.type).toBe('retryable_block');
  });

  test('prefers gate data pr_url over stale artifact pr_url', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let queriedRepo = '';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      const query = body.query as string;
      const isGraphQL = query.includes('repository(owner:$owner,name:$name)');
      if (!isGraphQL) {
        return {
          ok: true,
          json: async () => ({ data: { repository: null } }),
        } as Response;
      }
      queriedRepo = `${body.variables.owner}/${body.variables.name}`;
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                headRefOid: 'abc123',
                reactions: { nodes: [] },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: { data: { approved: true } },
      hookLocalState: { _codex_head_sha: 'abc123', _codex_started_at: Date.now() - 10_000 },
      currentArtifacts: [
        {
          id: 'old-artifact',
          nodeId: 'node-coding',
          type: 'result',
          key: 'old',
          data: { pr_url: 'https://github.com/old/repo/pull/99' },
          createdAt: Date.now() - 100_000,
          updatedAt: Date.now() - 100_000,
        },
      ],
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/new/repo/pull/42' },
          updatedAt: Date.now(),
        },
      ],
      templateData: { threshold: 1, requireCodex: true },
    });

    await reviewApprovalValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    // Should query the gate data URL (new/repo), not the artifact URL (old/repo)
    expect(queriedRepo).toBe('new/repo');
  });
});
