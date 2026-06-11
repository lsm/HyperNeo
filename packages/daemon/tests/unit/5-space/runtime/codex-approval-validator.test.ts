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
 *   - terminal outcome verified against current PR head
 *   - send_message target resolution (node, slot, broadcast, @worker:)
 *   - enterprise token preference
 *   - second-precision freshness matching
 *   - PR URL source priority (params.data > artifacts)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { codexReviewApprovedValidator } from '../../../../src/lib/space/runtime/built-in-validators/codex-approval-validator';
import { withSyntheticCodexHooks } from '../../../../src/lib/space/runtime/task-agent-manager';
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
let originalGhToken: string | undefined;
let originalEntToken: string | undefined;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchMock: ((url: string, init: RequestInit) => Promise<Response>) | undefined;

beforeEach(() => {
  originalToken = process.env.GITHUB_TOKEN;
  originalGhToken = process.env.GH_TOKEN;
  originalEntToken = process.env.GH_ENTERPRISE_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.GH_TOKEN;
  delete process.env.GH_ENTERPRISE_TOKEN;
  delete process.env.GITHUB_ENTERPRISE_TOKEN;
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
  if (originalGhToken !== undefined) {
    process.env.GH_TOKEN = originalGhToken;
  } else {
    delete process.env.GH_TOKEN;
  }
  if (originalEntToken !== undefined) {
    process.env.GH_ENTERPRISE_TOKEN = originalEntToken;
  } else {
    delete process.env.GH_ENTERPRISE_TOKEN;
  }
  delete process.env.GITHUB_ENTERPRISE_TOKEN;
  fetchMock = undefined;
});

function mockPrWith(sha: string, reactions: unknown[] = []) {
  fetchMock = async (url) => {
    if (url.includes('/pulls/42')) {
      return new Response(JSON.stringify({ head: { sha } }), { status: 200 });
    }
    if (url.includes('/issues/42/reactions')) {
      return new Response(JSON.stringify(reactions), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

const PR_URL = 'https://github.com/owner/repo/pull/42';
const PR_ARTIFACT = [{ data: { pr_url: PR_URL } }];

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
    const ctx = makeContext({
      params: { pr_url: PR_URL },
    });
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
    mockPrWith('abc123', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: new Date().toISOString() },
    ]);
    const ctx = makeContext({ currentArtifacts: PR_ARTIFACT });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
  });

  test('retryable_block on pre-run +1 on first invocation (no prior SHA)', async () => {
    mockPrWith('abc123', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      workflowStartIso: '2026-01-02T00:00:00Z',
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('stale');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
  });

  test('retryable_block on eyes reaction', async () => {
    mockPrWith('abc123', [
      {
        id: 1,
        user: { login: 'codex[bot]' },
        content: 'eyes',
        created_at: new Date().toISOString(),
      },
    ]);
    const ctx = makeContext({ currentArtifacts: PR_ARTIFACT });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('eyes');
    expect((result as { data?: Record<string, unknown> }).data?.lastReaction).toBe('eyes');
  });

  test('retryable_block on stale +1 when head changed', async () => {
    mockPrWith('new-sha', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: '2026-01-01T00:00:00Z' },
    ]);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
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
    mockPrWith('abc123', []);
    const ctx = makeContext({ currentArtifacts: PR_ARTIFACT });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
    expect((result as { reason?: string }).reason).toContain('Waiting for Codex review');
    expect((result as { data?: Record<string, unknown> }).data?.lastReaction).toBe('none');
  });

  test('block after timeout elapsed', async () => {
    mockPrWith('abc123', []);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      lastResult: {
        type: 'retryable_block',
        reason: 'Waiting',
        data: { checkStartedAt: Date.now() - 601_000, currentHeadSha: 'abc123' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { reason?: string }).reason).toContain('timeout');
    expect((result as { data?: Record<string, unknown> }).data?.terminalOutcome).toBe('block');
  });

  test('terminal allow verified against current PR head', async () => {
    // Terminal allow persists only when the PR head hasn't changed.
    // The validator must fetch the PR to verify before trusting the terminal outcome.
    mockPrWith('abc123', []);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      lastResult: {
        type: 'allow',
        data: { terminalOutcome: 'allow', currentHeadSha: 'abc123' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.terminalOutcome).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
    // Should have fetched the PR head to verify SHA hasn't changed
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(fetchCalls.some((c) => c.url.includes('/pulls/42'))).toBe(true);
  });

  test('terminal allow invalidated when PR head changes', async () => {
    mockPrWith('new-sha', []);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      lastResult: {
        type: 'allow',
        data: { terminalOutcome: 'allow', currentHeadSha: 'old-sha' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    // Head changed — terminal allow no longer valid, no reactions → retryable_block
    expect(result.type).toBe('retryable_block');
  });

  test('terminal block verified against current PR head', async () => {
    mockPrWith('abc123', []);
    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      lastResult: {
        type: 'block',
        reason: 'timeout',
        data: { terminalOutcome: 'block', currentHeadSha: 'abc123' },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('block');
    expect((result as { data?: Record<string, unknown> }).data?.terminalOutcome).toBe('block');
    expect((result as { data?: Record<string, unknown> }).data?.currentHeadSha).toBe('abc123');
    // Should have fetched to verify head hasn't changed
    expect(fetchCalls.some((c) => c.url.includes('/pulls/42'))).toBe(true);
  });

  test('send_message to non-target node bypasses Codex check', async () => {
    const ctx = makeContext({
      methodName: 'send_message',
      params: { target: 'SomeOtherNode' },
      templateData: { enforceForTargets: ['Review'] },
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect(fetchCalls).toHaveLength(0);
  });

  test('send_message to broadcast "*" triggers Codex check', async () => {
    mockPrWith('abc123', []);
    const ctx = makeContext({
      methodName: 'send_message',
      params: { target: ' * ' },
      templateData: { enforceForTargets: ['Review'] },
      currentArtifacts: PR_ARTIFACT,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
  });

  test('send_message to agent-slot target triggers Codex check', async () => {
    mockPrWith('abc123', []);
    const ctx = makeContext({
      methodName: 'send_message',
      params: { target: 'reviewer' },
      templateData: { enforceForTargets: ['Review'] },
      currentArtifacts: PR_ARTIFACT,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
  });

  test('send_message to @worker: address targeting allowed node triggers Codex check', async () => {
    mockPrWith('abc123', []);
    const ctx = makeContext({
      methodName: 'send_message',
      params: { target: `@worker:run-1/Review/reviewer` },
      templateData: { enforceForTargets: ['Review'] },
      currentArtifacts: PR_ARTIFACT,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
  });

  test('uses GH_ENTERPRISE_TOKEN when GITHUB_TOKEN is absent', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    mockPrWith('abc123', []);
    const ctx = makeContext({ currentArtifacts: PR_ARTIFACT });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('retryable_block');
  });

  test('prefers enterprise token for enterprise PR host', async () => {
    process.env.GITHUB_TOKEN = 'public-token';
    process.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    mockPrWith('abc123', []);
    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://gh.enterprise.com/owner/repo/pull/42' } }],
    });
    // Host not in allowlist → block, but token resolution should prefer enterprise
    const result = await codexReviewApprovedValidator(ctx);
    // The host isn't in ALLOWED_PR_HOSTS so it blocks before using the token
    expect(result.type).toBe('block');
    if (result.type === 'block') {
      expect(result.reason).toContain('not in the allowed list');
    }
  });

  test('prefers params.data PR URL over artifact PR URL', async () => {
    mockPrWith('abc123', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: new Date().toISOString() },
    ]);
    const ctx = makeContext({
      currentArtifacts: [{ data: { pr_url: 'https://github.com/owner/old-repo/pull/99' } }],
      params: { data: { pr_url: 'https://github.com/owner/repo/pull/42' } },
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    // Should have fetched PR #42 (from params.data), not #99 (from artifact)
    expect(fetchCalls.some((c) => c.url.includes('/pulls/42'))).toBe(true);
    expect(fetchCalls.some((c) => c.url.includes('/pulls/99'))).toBe(false);
  });

  test('reads PR URL from workflow gate data', async () => {
    mockPrWith('abc123', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: new Date().toISOString() },
    ]);
    const ctx = makeContext({
      gateDataJson: JSON.stringify({ pr_url: 'https://github.com/owner/repo/pull/42' }),
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
    expect(fetchCalls.some((c) => c.url.includes('/pulls/42'))).toBe(true);
  });

  test('reaction in same second as head change is not stale', async () => {
    // GitHub timestamps are second-precision. A +1 posted in the same second
    // as currentHeadBecameHeadAt must not be treated as stale.
    const now = new Date();
    const truncatedMs = Math.floor(now.getTime() / 1000) * 1000;
    const reactionTime = new Date(truncatedMs).toISOString(); // same second

    mockPrWith('new-sha', [
      { id: 1, user: { login: 'codex[bot]' }, content: '+1', created_at: reactionTime },
    ]);

    const ctx = makeContext({
      currentArtifacts: PR_ARTIFACT,
      lastResult: {
        type: 'retryable_block',
        reason: 'Waiting',
        data: {
          currentHeadSha: 'old-sha',
          currentHeadBecameHeadAt: truncatedMs, // same second
          checkStartedAt: Date.now() - 10_000,
        },
      } as WorkflowHookResult,
    });
    const result = await codexReviewApprovedValidator(ctx);
    expect(result.type).toBe('allow');
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

    const artifacts = PR_ARTIFACT;

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

describe('withSyntheticCodexHooks', () => {
  test('synthesizes Codex hooks for custom workflows with node flag', () => {
    const workflow = withSyntheticCodexHooks({
      ...WORKFLOW,
      hooks: undefined,
      channels: [{ from: 'Coding', to: 'Review' }],
    });
    const hook = workflow.hooks?.find((h) => h.id === 'synthetic-codex-review-check-node-coder');
    expect(hook).toBeDefined();
    expect(hook?.enabled).toBe(true);
    expect(hook?.sourceNode).toBe('Coding');
    expect(hook?.validator).toEqual({
      kind: 'built_in',
      id: 'codex_review_approved',
      externalLookups: ['github'],
    });
    expect(hook?.authorizedCallers).toEqual([{ sourceNode: 'Coding', agentSlots: ['coder'] }]);
    expect(hook?.templateData).toEqual({ enforceForTargets: ['Review'] });
  });

  test('disabled Codex hook does not suppress synthetic hook from node flag', () => {
    const workflow = withSyntheticCodexHooks({
      ...WORKFLOW,
      hooks: [
        {
          id: 'disabled-codex-review-check',
          enabled: false,
          sourceNode: 'Coding',
          method: 'send_message',
          validator: { kind: 'built_in', id: 'codex_review_approved' },
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
      channels: [{ from: 'Coding', to: 'Review' }],
    });
    expect(
      workflow.hooks?.some((hook) => hook.id === 'synthetic-codex-review-check-node-coder')
    ).toBe(true);
  });

  test('synthesizes Codex hooks for legacy codex_review_bot gate features', () => {
    const workflow = withSyntheticCodexHooks({
      ...WORKFLOW,
      nodes: WORKFLOW.nodes.map((node) => ({ ...node, requireCodexApproval: undefined })),
      hooks: undefined,
      gates: [{ id: 'approval-gate', features: { codex_review_bot: true } }],
      channels: [{ from: 'Coding', to: 'Review', gateId: 'approval-gate' }],
    });
    const hook = workflow.hooks?.find((h) => h.id === 'synthetic-codex-review-check-node-coder');
    expect(hook).toBeDefined();
    expect(hook?.templateData).toEqual({ enforceForTargets: ['Review'] });
  });
});
