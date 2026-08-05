/**
 * Coding-pack presets end-to-end tests (epic #2299; promoted from the #2300
 * spike in P2 #2302).
 *
 * THE HONESTY TEST: all three capabilities — pr_ready, pr_merged, codex —
 * re-expressed over the github connector + the generic external_state
 * validator + a domain-agnostic predicate, with ZERO engine special-casing.
 * Covers merged / open / conflict / UNKNOWN / rate-limit + the codex +1 path.
 *
 * Each preset is exercised through a mocked `gh` spawn; no production engine
 * code is on the stack.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearConnectorRegistry,
  createCodexReviewBotValidator,
  createPrMergedValidator,
  createPrReadyValidatorV2,
  createReviewPostedValidator,
  pollUntilAllow,
} from '../../../../../src/lib/space/runtime/connectors';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';
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

function mockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>
): typeof Bun.spawn {
  let i = 0;
  return (() => {
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

function ctx(opts: {
  prUrl?: string;
  methodName?: string;
  hookLocalState?: Record<string, unknown>;
  workflowRunCreatedAt?: number;
}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: opts.methodName ?? 'send_message',
    params: { target: 'Review', message: 'hi', data: { pr_url: opts.prUrl ?? PR_URL } },
    nodeId: 'node-1',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    workflowRunCreatedAt: opts.workflowRunCreatedAt,
    hookLocalState: opts.hookLocalState ?? {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
  };
}

const PR_VIEW = (overrides: Record<string, unknown> = {}) => ({
  url: PR_URL,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  ...overrides,
});

const EMPTY_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};

const RATE_LIMIT_PROBE_OK = {
  stdout: JSON.stringify({ resources: { graphql: { reset: 0 }, core: { reset: 0 } } }),
  stderr: '',
  exitCode: 0,
};

describe('pr_ready preset (coder→reviewer handoff gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  test('open + mergeable + clean + no unresolved threads → allow', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW()), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(PR_URL);
  });

  test('UNKNOWN mergeability → retryable_block (pending)', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW({ mergeable: 'UNKNOWN' })), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('pending external state');
  });

  test('conflict (mergeStateStatus DIRTY) → terminal block', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW({ mergeStateStatus: 'DIRTY' })), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('unresolved review threads → terminal block', async () => {
    const threads = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 't1', isResolved: false, comments: { nodes: [{ url: 'https://g/c/1' }] } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW()), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(threads), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('rate-limited gh → retryable_block (not terminal)', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
  });
});

describe('pr_merged preset (mark_complete merge gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  test('state MERGED → allow', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'MERGED' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('allow');
  });

  test('state OPEN → retryable_block (merge in flight)', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'OPEN' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('retryable_block');
  });

  test('state CLOSED → terminal block', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'CLOSED' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('block');
  });

  test('rate-limited gh → retryable_block', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('retryable_block');
  });
});

describe('codex_review_bot preset (codex +1 reaction gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  const FRESH = '2026-08-02T12:00:00Z';

  function reactions(...rxns: Array<{ login: string; content: string; at: string }>) {
    return rxns.map((r) => ({
      user: { login: r.login },
      content: r.content,
      created_at: r.at,
    }));
  }

  test('fresh codex-bot +1 → allow', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: '+1', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('allow');
  });

  test('stale codex-bot +1 (before freshness) → retryable_block (filtered out)', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: '+1', at: '2026-08-02T11:00:00Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('eyes only (no +1) → retryable_block (poll)', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: 'eyes', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('non-codex +1 does not satisfy the predicate', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'dependabot[bot]', content: '+1', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('rate-limited gh → retryable_block', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('pollUntilAllow converts a pending result to allow once expired (timeout semantics)', async () => {
    const inner = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: 'eyes', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const validate = pollUntilAllow(inner, (c) => c.hookLocalState?.expired === true, {
      codex_bot_reaction: 'timeout',
      codex_bot_warning: '+1 missing after timeout; allowing',
    });
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH, expired: true } }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.codex_bot_reaction).toBe('timeout');
  });

  test('pollUntilAllow does NOT open the gate on a connector failure (rate limit)', async () => {
    // Inner validator hits a rate limit → retryable_block that is NOT a
    // predicate-pending result. Even past the deadline, an outage must not
    // open the approval gate — it stays retryable_block.
    const inner = createCodexReviewBotValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const validate = pollUntilAllow(inner, () => true, {
      codex_bot_reaction: 'timeout',
      codex_bot_warning: 'should not happen',
    });
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
    expect((result as { data?: Record<string, unknown> }).data?.codex_bot_reaction).toBeUndefined();
  });
});

describe('review_posted preset (Review→Coding feedback gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  // Workflow started at 00:00; a review/comment at 12:00 is "fresh".
  const START_MS = Date.parse('2026-05-01T00:00:00Z');
  const AFTER = '2026-05-01T12:00:00Z';
  const BEFORE = '2026-04-30T12:00:00Z';

  /** Build a mock spawn that serves the `gh pr view` payload then the
   *  `gh api user` viewer login (in that order — the op always fetches both). */
  function reviewSpawn(prView: Record<string, unknown>, viewerLogin: string | null) {
    return mockSpawn([
      { stdout: JSON.stringify(prView), stderr: '', exitCode: 0 },
      viewerLogin === null
        ? { stdout: '', stderr: 'could not resolve viewer', exitCode: 1 }
        : { stdout: JSON.stringify({ login: viewerLogin }), stderr: '', exitCode: 0 },
    ]);
  }

  test('formal CHANGES_REQUESTED review since start → allow (formal_review)', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: AFTER, state: 'CHANGES_REQUESTED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
      pr_url: PR_URL,
      review_evidence: 'formal_review',
      review_count: 1,
    });
  });

  test('formal APPROVED review since start → allow (formal_review)', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: AFTER, state: 'APPROVED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.review_evidence).toBe(
      'formal_review'
    );
  });

  test('own-PR COMMENTED review since start → allow (own_pr_comment fallback)', async () => {
    // GitHub blocks self-APPROVE, so a COMMENTED review counts on an own PR.
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'lsm' },
          reviews: [{ submittedAt: AFTER, state: 'COMMENTED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
      pr_url: PR_URL,
      review_evidence: 'own_pr_comment',
      review_count: 1,
    });
  });

  test('own-PR PR conversation comment since start → allow (own_pr_comment fallback)', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        { url: PR_URL, author: { login: 'lsm' }, reviews: [], comments: [{ createdAt: AFTER }] },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.review_evidence).toBe(
      'own_pr_comment'
    );
  });

  test('comment-only evidence on a NON-own PR → terminal block', async () => {
    // author != viewer → not an own PR → comment-only evidence is rejected.
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: AFTER, state: 'COMMENTED' }],
          comments: [{ createdAt: AFTER }],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not satisfied');
  });

  test('stale formal review (before workflow start) → block (since-start window)', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: BEFORE, state: 'CHANGES_REQUESTED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('block');
  });

  test('stale comment on own PR (before workflow start) → block', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'lsm' },
          reviews: [{ submittedAt: BEFORE, state: 'COMMENTED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('block');
  });

  test('since-start window also resolves from hookLocalState.workflowStartIso (gate path)', async () => {
    // The gate evaluator dispatch path carries the anchor via hookLocalState, not
    // workflowRunCreatedAt. Prove both entry points resolve the window.
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: AFTER, state: 'APPROVED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate(
      ctx({ hookLocalState: { workflowStartIso: '2026-05-01T00:00:00Z' } })
    );
    expect(result.type).toBe('allow');
  });

  test('review_url fallback: with no pr_url, the review permalink resolves the PR', async () => {
    // Mirrors the legacy gate test: when only review_url is present, the resolver
    // falls back to it and `gh pr view` resolves the PR from the permalink.
    const reviewUrl = 'https://github.com/acme/corp/pull/42#pullrequestreview-123';
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'someone-else' },
          reviews: [{ submittedAt: AFTER, state: 'CHANGES_REQUESTED' }],
          comments: [],
        },
        'lsm'
      )
    );
    const result = await validate({
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'review-posted-gate',
      methodName: 'send_message',
      // No pr_url anywhere — only review_url (the gate-data fallback path).
      params: { data: { review_url: reviewUrl } },
      rawParams: { data: { review_url: reviewUrl } },
      nodeId: '',
      nodeName: '',
      sessionId: '',
      taskId: '',
      hookLocalState: { review_url: reviewUrl, workflowStartIso: '2026-05-01T00:00:00Z' },
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.review_evidence).toBe(
      'formal_review'
    );
  });

  test('rate-limited gh (pr view) → retryable_block', async () => {
    const validate = createReviewPostedValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('retryable_block');
  });

  test('missing workflow-start window → block (fail loud, no silent accept)', async () => {
    const validate = createReviewPostedValidator(
      reviewSpawn(
        {
          url: PR_URL,
          author: { login: 'lsm' },
          reviews: [{ submittedAt: AFTER, state: 'APPROVED' }],
          comments: [],
        },
        'lsm'
      )
    );
    // No workflowRunCreatedAt, no hookLocalState.workflowStartIso.
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('sinceIso');
  });

  test('missing pr_url → block (op fails closed)', async () => {
    const validate = createReviewPostedValidator(reviewSpawn({ url: PR_URL }, 'lsm'));
    const result = await validate({
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'review-posted-gate',
      methodName: 'send_message',
      params: { data: {} }, // no pr_url, no review_url
      nodeId: '',
      nodeName: '',
      sessionId: '',
      taskId: '',
      hookLocalState: { workflowStartIso: '2026-05-01T00:00:00Z' },
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('block');
  });

  test('host allow-list: a non-github.com / non-GH_HOST pr_url is rejected with NO gh call', async () => {
    // Security (P1): an attacker-influenced pr_url must not direct the daemon's
    // GitHub credentials (esp. GH_ENTERPRISE_TOKEN) at an arbitrary host. The
    // allow-list (github.com or GH_HOST) fires BEFORE any gh spawn — the thrown
    // spawn proves no credential-bearing call is made.
    const validate = createReviewPostedValidator((() => {
      throw new Error('gh must not be called for a disallowed host');
    }) as unknown as typeof Bun.spawn);
    const result = await validate(
      ctx({
        prUrl: 'https://evil.example.com/acme/corp/pull/42',
        workflowRunCreatedAt: START_MS,
      })
    );
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('not allowed');
  });

  test('host allow-list: a pr_url matching GH_HOST (GitHub Enterprise) passes through', async () => {
    // GHES runs on a custom host; setting GH_HOST admits it. Guards against the
    // allow-list regressing GHES support (the whole reason --hostname exists).
    const ghesUrl = 'https://ghes.corp.example/acme/corp/pull/42';
    const original = process.env.GH_HOST;
    process.env.GH_HOST = 'ghes.corp.example';
    try {
      const validate = createReviewPostedValidator(
        reviewSpawn(
          {
            url: ghesUrl,
            author: { login: 'someone-else' },
            reviews: [{ submittedAt: AFTER, state: 'APPROVED' }],
            comments: [],
          },
          'bot'
        )
      );
      const result = await validate(ctx({ prUrl: ghesUrl, workflowRunCreatedAt: START_MS }));
      expect(result.type).toBe('allow');
    } finally {
      if (original === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = original;
    }
  });
});
