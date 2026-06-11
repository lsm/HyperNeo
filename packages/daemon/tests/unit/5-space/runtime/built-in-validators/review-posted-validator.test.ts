/**
 * Unit tests for reviewPostedValidator.
 *
 * Covers: review evidence validation via message data and artifacts.
 */

import { describe, test, expect } from 'bun:test';
import { reviewPostedValidator } from '../../../../../src/lib/space/runtime/built-in-validators/review-posted-validator';
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

describe('reviewPostedValidator', () => {
  test('blocks when no review evidence is provided', async () => {
    const ctx = makeCtx();
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('allows when review_url is in message data', async () => {
    const ctx = makeCtx({
      params: { data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' } },
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('Review evidence verified');
  });

  test('allows when a review artifact exists', async () => {
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('artifact');
  });

  test('prefers message data over artifacts', async () => {
    const ctx = makeCtx({
      params: { data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r2' } },
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('message_data');
  });

  test('blocks when review_url is not a valid GitHub PR URL', async () => {
    const ctx = makeCtx({
      params: { data: { review_url: 'https://example.com/anything' } },
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('blocks when artifact has no review_url', async () => {
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { summary: 'looks good' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
  });

  test('recognizes review_feedback artifact type', async () => {
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review_feedback',
          key: 'current',
          data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('allow');
  });

  test('rejects stale review artifact when newer non-review work exists', async () => {
    const now = Date.now();
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a2',
          nodeId: 'node-coding',
          type: 'result',
          key: 'revision-2',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('accepts enterprise GitHub host for review URL', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GH_ENTERPRISE_TOKEN;
    const originalGhHost = process.env.GH_HOST;
    process.env.GH_ENTERPRISE_TOKEN = 'test-token';
    process.env.GH_HOST = 'github.enterprise.com';
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [{ createdAt: '2999-01-01T00:00:00Z' }] },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.enterprise.com/org/repo/pull/42#discussion_r1' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.enterprise.com/org/repo/pull/42' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GH_ENTERPRISE_TOKEN = originalToken;
    process.env.GH_HOST = originalGhHost;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('message_data');
  });

  test('blocks review URL from a different PR than the active one', async () => {
    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/other/repo/pull/99#discussion_r1' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('allows review URL matching the active PR', async () => {
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
                reviews: { nodes: [] },
                comments: { nodes: [{ createdAt: '2999-01-01T00:00:00Z' }] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('does not send credentials to untrusted review URL host', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://attacker.example/org/repo/pull/1#discussion_r42' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://attacker.example/org/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(fetchCalled).toBe(false);
    expect(result.type).toBe('block');
  });
});
