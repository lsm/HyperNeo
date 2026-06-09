/**
 * Unit tests for codexReviewApprovedValidator
 *
 * Covers:
 *   - allow when node does not require Codex
 *   - block when missing GitHub token or PR URL
 *   - allow on fresh +1 reaction for current head
 *   - retryable_block on eyes reaction
 *   - retryable_block on stale +1 (head changed)
 *   - retryable_block when no reaction exists
 *   - block after timeout
 *   - terminal outcome persisted via lastResult.data
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { codexReviewApprovedValidator } from '../../../../src/lib/space/runtime/built-in-validators/codex-approval-validator';
import type { HookExecutorContext } from '../../../../src/lib/space/runtime/hook-executor';
import type { SpaceWorkflow, WorkflowHookResult } from '@neokai/shared';

const WORKFLOW: SpaceWorkflow = {
  id: 'wf-1',
  spaceId: 'space-1',
  name: 'Test',
  tags: [],
  nodes: [
    {
      id: 'node-coder',
      name: 'Coding',
      agents: [{ agentId: 'a1', name: 'coder' }],
      requireCodexApproval: true,
    },
    { id: 'node-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
  ],
  startNodeId: 'node-coder',
  endNodeId: 'node-review',
  channels: [],
  gates: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  completionAutonomyLevel: 3,
};

function makeContext(overrides: Partial<HookExecutorContext> = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-codex',
    methodName: 'submit_for_approval',
    params: {},
    nodeId: 'node-coder',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
    workflow: WORKFLOW,
    ...overrides,
  } as HookExecutorContext;
}

let originalToken: string | undefined;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchMock: ((url: string, init: RequestInit) => Promise<Response>) | undefined;

beforeEach(() => {
  originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  fetchCalls = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: urlStr, init: init ?? {} });
    if (fetchMock) {
      return fetchMock(urlStr, init ?? {});
    }
    return originalFetch(url, init);
  };
});

afterEach(() => {
  if (originalToken !== undefined) {
    process.env.GITHUB_TOKEN = originalToken;
  } else {
    delete process.env.GITHUB_TOKEN;
  }
  fetchMock = undefined;
});

describe('codexReviewApprovedValidator', () => {
  test('allow when node does not require Codex', async () => {
    const ctx = makeContext({
      workflow: {
        ...WORKFLOW,
        nodes: WORKFLOW.nodes.map((n) =>
          n.name === 'Coding' ? { ...n, requireCodexApproval: false } : n
        ),
      },
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
  });

  test('block when github external lookup not permitted', async () => {
    const ctx = makeContext({ permittedExternalLookups: [] });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { reason?: string }).reason).toContain('github external lookup');
  });

  test('block when no GitHub token', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const ctx = makeContext();
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { reason?: string }).reason).toContain('GitHub token not available');
  });

  test('block when no PR URL available', async () => {
    const ctx = makeContext();
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { reason?: string }).reason).toContain('No PR URL');
  });

  test('allow on fresh +1 for current head', async () => {
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'abc123' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: 'codex[bot]' },
              content: '+1',
              created_at: new Date().toISOString(),
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
  });

  test('allow on pre-existing +1 on first invocation (no prior SHA)', async () => {
    // Simulates Codex approving before the agent calls submit_for_approval.
    // The +1 was posted in the past, but on first call we have no prior head
    // SHA so it must be treated as fresh.
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'abc123' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: 'codex[bot]' },
              content: '+1',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
  });

  test('retryable_block on eyes reaction', async () => {
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'abc123' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: 'codex[bot]' },
              content: 'eyes',
              created_at: new Date().toISOString(),
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('eyes');
    expect((result as { data?: Record<string, unknown> }).data?.lastReaction).toBe('eyes');
  });

  test('retryable_block on stale +1 when head changed', async () => {
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'new-sha' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              user: { login: 'codex[bot]' },
              content: '+1',
              created_at: '2026-01-01T00:00:00Z',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
      lastResult: {
        type: 'retryable_block',
        reason: 'Waiting',
        data: { currentHeadSha: 'old-sha', checkStartedAt: Date.now() - 10_000 },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('stale');
    expect((result as { data?: Record<string, unknown> }).data?.lastReaction).toBe(
      'stale_plus_one'
    );
  });

  test('retryable_block when no reaction exists', async () => {
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'abc123' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('Waiting for Codex review');
    expect((result as { data?: Record<string, unknown> }).data?.lastReaction).toBe('none');
  });

  test('block after timeout elapsed', async () => {
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        return new Response(JSON.stringify({ head: { sha: 'abc123' } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
      lastResult: {
        type: 'retryable_block',
        reason: 'Waiting',
        data: {
          checkStartedAt: Date.now() - 601_000,
          currentHeadSha: 'abc123',
        },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { reason?: string }).reason).toContain('timeout');
    expect((result as { data?: Record<string, unknown> }).data?.terminalOutcome).toBe('block');
  });

  test('terminal allow persists across invocations', async () => {
    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
      lastResult: {
        type: 'allow',
        data: { terminalOutcome: 'allow', currentHeadSha: 'abc123' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect(fetchCalls).toHaveLength(0);
  });

  test('terminal block persists across invocations', async () => {
    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }],
      lastResult: {
        type: 'block',
        reason: 'timeout',
        data: { terminalOutcome: 'block', currentHeadSha: 'abc123' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect(fetchCalls).toHaveLength(0);
  });

  test('head change resets freshness anchor', async () => {
    let callCount = 0;
    fetchMock = async (url) => {
      if (url.includes('/pulls/42')) {
        callCount++;
        const sha = callCount === 1 ? 'old-sha' : 'new-sha';
        return new Response(JSON.stringify({ head: { sha } }), { status: 200 });
      }
      if (url.includes('/issues/42/reactions')) {
        return new Response('[]', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const artifacts = [{ data: { pr_url: 'https://github.com/owner/repo/pull/42' } }];

    // First call: old head, no reactions
    const result1 = await codexReviewApprovedValidator(
      makeContext({ currentArtifacts: artifacts })
    );
    expect(result1.type).toBe('retryable_block');
    expect((result1 as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('old-sha');

    // Second call: new head, freshness anchor updated
    const result2 = await codexReviewApprovedValidator(
      makeContext({
        currentArtifacts: artifacts,
        lastResult: result1 as WorkflowHookResult,
      })
    );
    expect(result2.type).toBe('retryable_block');
    const data2 = (result2 as { data?: Record<string, unknown> }).data;
    expect(data2?.currentHeadSha).toBe('new-sha');
    expect(typeof data2?.currentHeadBecameHeadAt).toBe('number');
  });
});
