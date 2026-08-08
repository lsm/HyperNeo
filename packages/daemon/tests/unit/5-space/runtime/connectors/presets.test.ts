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
  createCodexApprovalValidator,
  createPrMergedValidator,
  createPrReadyValidatorV2,
  createReviewPostedValidator,
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

describe('codex_review_approved preset (codex +1 gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  const HEAD = 'headsha123';
  // Times are relative to now so the 2h timeout window is never already elapsed.
  const WAIT = new Date(Date.now() - 60_000).toISOString();
  const NOW = new Date().toISOString();
  const BEFORE_WAIT = new Date(Date.now() - 300_000).toISOString();

  // getCodexApproval runs FOUR gh calls: REST pull metadata (head.sha), the
  // issue EVENTS timeline (referenced event commit_id + created_at — the
  // observed head-update anchor), then reactions, then comments. prView returns
  // the two metadata results.
  function prView(headRefOid = HEAD, pushedAt = new Date(Date.now() - 60_000).toISOString()) {
    return [
      {
        stdout: JSON.stringify({ number: 42, head: { sha: headRefOid }, html_url: PR_URL }),
        stderr: '',
        exitCode: 0,
      },
      {
        stdout: JSON.stringify([
          { event: 'referenced', commit_id: headRefOid, created_at: pushedAt },
        ]),
        stderr: '',
        exitCode: 0,
      },
    ];
  }
  function reactions(...rxns: Array<{ login: string; content: string; at: string }>) {
    return {
      stdout: JSON.stringify(
        rxns.map((r) => ({ user: { login: r.login }, content: r.content, created_at: r.at }))
      ),
      stderr: '',
      exitCode: 0,
    };
  }
  function comments(...cmts: Array<{ login: string; body: string; at: string }>) {
    return {
      stdout: JSON.stringify(
        cmts.map((c) => ({ user: { login: c.login }, body: c.body, created_at: c.at }))
      ),
      stderr: '',
      exitCode: 0,
    };
  }

  test('codex comment on the current head → allow (no wait started yet)', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(),
        reactions(),
        comments({ login: 'codex[bot]', body: `reviewed ${HEAD}`, at: NOW }),
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.codex_approved).toBe(true);
  });

  test('fresh codex +1 after wait started, head unchanged → allow', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(),
        reactions({ login: 'codex[bot]', content: '+1', at: NOW }),
        comments(),
      ])
    );
    const result = await validate(
      ctx({ hookLocalState: { codex_wait_started_at: WAIT, codex_wait_head_oid: HEAD } })
    );
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.codex_approved).toBe(true);
  });

  test('no +1/comment → retryable_block that records the wait start', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(typeof data.codex_wait_started_at).toBe('string');
    expect(data.codex_wait_head_oid).toBe(HEAD);
  });

  test('stale +1 (before wait started) does NOT satisfy; retryable_block continues the wait', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(),
        reactions({ login: 'codex[bot]', content: '+1', at: BEFORE_WAIT }),
        comments(),
      ])
    );
    const result = await validate(
      ctx({ hookLocalState: { codex_wait_started_at: WAIT, codex_wait_head_oid: HEAD } })
    );
    expect(result.type).toBe('retryable_block');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(data.codex_wait_started_at).toBe(WAIT);
  });

  test('head changed since the wait started → restart the wait window', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView('newsha456'), reactions(), comments()])
    );
    const result = await validate(
      ctx({ hookLocalState: { codex_wait_started_at: WAIT, codex_wait_head_oid: HEAD } })
    );
    expect(result.type).toBe('retryable_block');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(data.codex_wait_head_oid).toBe('newsha456');
  });

  test('non-codex +1 does not satisfy', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(),
        reactions({ login: 'dependabot[bot]', content: '+1', at: NOW }),
        comments(),
      ])
    );
    const result = await validate(
      ctx({ hookLocalState: { codex_wait_started_at: WAIT, codex_wait_head_oid: HEAD } })
    );
    expect(result.type).toBe('retryable_block');
  });

  test('wait elapsed → allow with codex_timed_out', async () => {
    const longAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(
      ctx({ hookLocalState: { codex_wait_started_at: longAgo, codex_wait_head_oid: HEAD } })
    );
    expect(result.type).toBe('allow');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(data.codex_timed_out).toBe(true);
    expect(data.codex_approved).toBe(false);
  });

  test('rate-limited gh → retryable_block (never opens the gate on an outage)', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('a current-cycle +1 on the FIRST terminal call is honored (pre-close +1)', async () => {
    // Reviewer waited for codex, then closes: waitStarted is undefined on the
    // first call, but the +1 is fresh relative to the workflow (cycle) start, so
    // it must allow rather than starting the wait after the +1 (which would
    // strand the reviewer waiting for a reaction that never comes).
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(),
        reactions({ login: 'codex[bot]', content: '+1', at: NOW }),
        comments(),
      ])
    );
    const result = await validate(ctx({ workflowRunCreatedAt: Date.now() - 600_000 }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.codex_approved).toBe(true);
  });

  test('a +1 from BEFORE the last push is stale on the first call (head binding)', async () => {
    // Codex +1'd head A, then a push advanced the head (pushedAt AFTER the +1):
    // the +1 predates the current head and must NOT satisfy on the first call.
    const pushedAt = new Date(Date.now() - 30_000).toISOString();
    const stalePlusOneAt = new Date(Date.now() - 120_000).toISOString();
    const validate = createCodexApprovalValidator(
      mockSpawn([
        ...prView(HEAD, pushedAt),
        reactions({ login: 'codex[bot]', content: '+1', at: stalePlusOneAt }),
        comments(),
      ])
    );
    const result = await validate(ctx({ workflowRunCreatedAt: Date.now() - 600_000 }));
    expect(result.type).toBe('retryable_block');
  });

  test('corrupted codex_wait_started_at restarts the wait instead of deadlocking', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(
      ctx({
        hookLocalState: { codex_wait_started_at: 'not-a-timestamp', codex_wait_head_oid: HEAD },
      })
    );
    // An unparseable anchor must NOT count elapsed time forever (permanent
    // retryable_block) — it restarts the window with a fresh timestamp.
    expect(result.type).toBe('retryable_block');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(typeof data.codex_wait_started_at).toBe('string');
    expect(data.codex_wait_started_at).not.toBe('not-a-timestamp');
  });

  test('GATE path: pending codex returns a retryable_block with no wait anchor to persist', async () => {
    // When used as a gate's built-in validator (gate-on-external-state),
    // runGateValidator sets workflowStartIso + gateDataUpdatedIso in hook-local
    // state. No wait-state is persisted, so the block data is empty.
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(
      ctx({
        hookLocalState: {
          workflowStartIso: new Date(Date.now() - 600_000).toISOString(),
          gateDataUpdatedIso: new Date(Date.now() - 30_000).toISOString(),
          pr_url: PR_URL,
        },
      })
    );
    expect(result.type).toBe('retryable_block');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(data.codex_wait_started_at).toBeUndefined();
  });

  test('GATE path: timeout anchors to the approval handoff (gateDataUpdatedIso), not the workflow start', async () => {
    // A long-running workflow must still get a full post-approval codex window:
    // the 2h timeout anchors to gateDataUpdatedIso (the last approval write),
    // so an OLD workflow start with a RECENT approval write does NOT time out.
    const longAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(
      ctx({
        hookLocalState: {
          workflowStartIso: longAgo,
          gateDataUpdatedIso: new Date(Date.now() - 60_000).toISOString(),
          pr_url: PR_URL,
        },
      })
    );
    expect(result.type).toBe('retryable_block');
  });

  test('GATE path: timeout-allow fires once the approval handoff is old (no persistence)', async () => {
    const longAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const validate = createCodexApprovalValidator(
      mockSpawn([...prView(), reactions(), comments()])
    );
    const result = await validate(
      ctx({ hookLocalState: { workflowStartIso: longAgo, pr_url: PR_URL } })
    );
    // With no gateDataUpdatedIso (no approval write yet), the timeout falls back
    // to the workflow start.
    expect(result.type).toBe('allow');
    const data = (result as { data?: Record<string, unknown> }).data ?? {};
    expect(data.codex_timed_out).toBe(true);
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

  test('host allow-list: a URL parsePrUrl rejects (non-/pull/<digits>) is still host-checked', async () => {
    // Regression (P1 bypass): parsePrUrl requires `/pull/<digits>`, so a URL like
    // .../pull/42abc returned null and slipped past the parsePrUrl-keyed
    // allow-list, reaching `gh pr view` (which posts to the host with an
    // Authorization header). The URL-parser-based allow-list must catch it.
    const validate = createReviewPostedValidator((() => {
      throw new Error('gh must not be called for a disallowed host');
    }) as unknown as typeof Bun.spawn);
    const result = await validate(
      ctx({
        prUrl: 'https://evil.example.com/acme/corp/pull/42abc',
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

  test('viewer-lookup rate limit with only comment evidence → retryable_block (preserve retry)', async () => {
    // `gh pr view` succeeds (own-PR author + a COMMENTED review), but
    // `gh api user` is rate-limited. The own-PR determination is inconclusive
    // AND it matters (the comment evidence would pass iff ownPr), so the rate
    // limit must surface as retryable_block — not a terminal "not satisfied"
    // block that stalls the Review→Coding loop for the duration of throttling.
    const validate = createReviewPostedValidator(
      mockSpawn([
        {
          stdout: JSON.stringify({
            url: PR_URL,
            author: { login: 'lsm' },
            reviews: [{ submittedAt: AFTER, state: 'COMMENTED' }],
            comments: [],
          }),
          stderr: '',
          exitCode: 0,
        },
        { stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 },
      ])
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('retryable_block');
  });

  test('viewer-lookup rate limit is ignored when a formal review exists (viewer irrelevant)', async () => {
    // A formal review counts regardless of ownPr, so a viewer-lookup failure
    // (even a rate limit) must NOT propagate — the gate allows on the formal
    // review. Guards the `formalReviewCount === 0` leg of the propagation.
    const validate = createReviewPostedValidator(
      mockSpawn([
        {
          stdout: JSON.stringify({
            url: PR_URL,
            author: { login: 'someone-else' },
            reviews: [{ submittedAt: AFTER, state: 'APPROVED' }],
            comments: [],
          }),
          stderr: '',
          exitCode: 0,
        },
        { stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 },
      ])
    );
    const result = await validate(ctx({ workflowRunCreatedAt: START_MS }));
    expect(result.type).toBe('allow');
  });
});
