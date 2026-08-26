import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearConnectorRegistry,
  createCodexApprovalValidator,
  createPrMergedValidator,
  createPrReadyValidatorV2,
  createReviewPostedValidator,
} from '../../../../../src/lib/space/runtime/connectors';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';
import {
  resolveGithubConfigDir,
  runGhJson,
} from '../../../../../src/lib/space/runtime/gh-lookup-helpers';
import type { SpawnFn, SpawnProcess } from '../../../../../src/lib/runtime-spawn';
import { MAX_BUFFER_BYTES } from '../../../../../src/lib/space/runtime/script-utils';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../../src/lib/space/runtime/rate-limit-detector';
import { _setStartupEnvBaselineForTesting } from '../../../../../src/lib/spawn-env';

const PR_URL = 'https://github.com/acme/corp/pull/42';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockSpawn(results: Array<{ stdout: string; stderr: string; exitCode: number }>): SpawnFn {
  let i = 0;
  return (() => {
    const result = results[i++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as SpawnProcess;
  }) as unknown as SpawnFn;
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

describe('resolveGithubConfigDir', () => {
  test.skipIf(existsSync(join(homedir(), '.config', 'gh')))(
    'resolves the Windows AppData gh config location',
    () => {
      const appData = join(
        tmpdir(),
        `gh-appdata-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      mkdirSync(join(appData, 'GitHub CLI'), { recursive: true });
      try {
        expect(resolveGithubConfigDir({ AppData: appData })).toBe(join(appData, 'GitHub CLI'));
      } finally {
        rmSync(appData, { recursive: true, force: true });
      }
    }
  );
});

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

  test('transient GitHub 5xx → retryable_block (not terminal)', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 502: bad gateway', exitCode: 1 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('retryable_block');
  });
});

describe('codex_review_approved preset (codex approval gate, opt-in hook)', () => {
  beforeEach(() => clearConnectorRegistry());

  const HEAD_SHA = 'deadbeefcafebabe0000000000000000deadbeef';

  function reviews(...rvs: Array<{ login: string; state: string; commitId: string; at?: string }>) {
    return rvs.map((r) => ({
      user: { login: r.login },
      state: r.state,
      commit_id: r.commitId,
      submitted_at: r.at ?? '',
    }));
  }

  function codexSpawn(rvs: unknown[]) {
    return mockSpawn([
      { stdout: JSON.stringify({ url: PR_URL }), stderr: '', exitCode: 0 },
      {
        stdout: JSON.stringify({ number: 42, headRefOid: HEAD_SHA, url: PR_URL }),
        stderr: '',
        exitCode: 0,
      },
      { stdout: JSON.stringify(rvs), stderr: '', exitCode: 0 },
      { stdout: JSON.stringify({ headRefOid: HEAD_SHA }), stderr: '', exitCode: 0 },
    ]);
  }

  test('codex APPROVED review on the current head → allow', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(reviews({ login: 'codex[bot]', state: 'APPROVED', commitId: HEAD_SHA }))
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data).toMatchObject({
      codex_approved: true,
      head_sha: HEAD_SHA,
      pr_url: PR_URL,
    });
  });

  test('a later codex CHANGES_REQUESTED on the same head supersedes an earlier APPROVED', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews(
          {
            login: 'codex[bot]',
            state: 'APPROVED',
            commitId: HEAD_SHA,
            at: '2026-08-09T10:00:00Z',
          },
          {
            login: 'codex[bot]',
            state: 'CHANGES_REQUESTED',
            commitId: HEAD_SHA,
            at: '2026-08-09T11:00:00Z',
          }
        )
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('a later codex COMMENTED does not revoke an earlier APPROVED', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews(
          {
            login: 'codex[bot]',
            state: 'APPROVED',
            commitId: HEAD_SHA,
            at: '2026-08-09T10:00:00Z',
          },
          {
            login: 'codex[bot]',
            state: 'COMMENTED',
            commitId: HEAD_SHA,
            at: '2026-08-09T11:00:00Z',
          }
        )
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
  });

  test('a later COMMENTED does NOT clear an outstanding CHANGES_REQUESTED (three-state)', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews(
          {
            login: 'codex[bot]',
            state: 'APPROVED',
            commitId: HEAD_SHA,
            at: '2026-08-09T10:00:00Z',
          },
          {
            login: 'codex[bot]',
            state: 'CHANGES_REQUESTED',
            commitId: HEAD_SHA,
            at: '2026-08-09T11:00:00Z',
          },
          {
            login: 'codex[bot]',
            state: 'COMMENTED',
            commitId: HEAD_SHA,
            at: '2026-08-09T12:00:00Z',
          }
        )
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('a later APPROVED re-approves after a CHANGES_REQUESTED', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews(
          {
            login: 'codex[bot]',
            state: 'CHANGES_REQUESTED',
            commitId: HEAD_SHA,
            at: '2026-08-09T10:00:00Z',
          },
          { login: 'codex[bot]', state: 'APPROVED', commitId: HEAD_SHA, at: '2026-08-09T11:00:00Z' }
        )
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
  });

  test('same-second APPROVED then CHANGES_REQUESTED → retryable_block (array order wins)', async () => {
    const sameSecond = '2026-08-09T10:00:00Z';
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews(
          { login: 'codex[bot]', state: 'APPROVED', commitId: HEAD_SHA, at: sameSecond },
          { login: 'codex[bot]', state: 'CHANGES_REQUESTED', commitId: HEAD_SHA, at: sameSecond }
        )
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('review history exceeding the 10-page cap → terminal block (fail closed)', async () => {
    const fullPage = [
      ...reviews({
        login: 'codex[bot]',
        state: 'APPROVED',
        commitId: HEAD_SHA,
        at: '2026-08-09T10:00:00Z',
      }),
      ...Array.from({ length: 99 }, (_, i) => ({
        user: { login: `reviewer${i}` },
        state: 'COMMENTED',
        commit_id: HEAD_SHA,
        submitted_at: '2026-08-09T10:00:00Z',
      })),
    ];
    const validate = createCodexApprovalValidator(
      mockSpawn([
        { stdout: JSON.stringify({ url: PR_URL }), stderr: '', exitCode: 0 },
        {
          stdout: JSON.stringify({ number: 42, headRefOid: HEAD_SHA, url: PR_URL }),
          stderr: '',
          exitCode: 0,
        },
        ...Array.from({ length: 10 }, () => ({
          stdout: JSON.stringify(fullPage),
          stderr: '',
          exitCode: 0,
        })),
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('scan cap');
  });

  test('9 full pages + a short 10th page does NOT trip the fail-closed cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      user: { login: `reviewer${i}` },
      state: 'COMMENTED',
      commit_id: HEAD_SHA,
      submitted_at: '2026-08-09T10:00:00Z',
    }));
    const validate = createCodexApprovalValidator(
      mockSpawn([
        { stdout: JSON.stringify({ url: PR_URL }), stderr: '', exitCode: 0 },
        {
          stdout: JSON.stringify({ number: 42, headRefOid: HEAD_SHA, url: PR_URL }),
          stderr: '',
          exitCode: 0,
        },
        ...Array.from({ length: 9 }, () => ({
          stdout: JSON.stringify(fullPage),
          stderr: '',
          exitCode: 0,
        })),
        {
          stdout: JSON.stringify(
            reviews({
              login: 'codex[bot]',
              state: 'APPROVED',
              commitId: HEAD_SHA,
              at: '2026-08-09T11:00:00Z',
            })
          ),
          stderr: '',
          exitCode: 0,
        },
        { stdout: JSON.stringify({ headRefOid: HEAD_SHA }), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
  });

  test('codex APPROVED review on a different commit → retryable_block (head-binding)', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(
        reviews({
          login: 'codex[bot]',
          state: 'APPROVED',
          commitId: 'oldersha000000000000000000000000000',
        })
      )
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('codex COMMENTED review (not APPROVED) → retryable_block', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(reviews({ login: 'codex[bot]', state: 'COMMENTED', commitId: HEAD_SHA }))
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('non-codex bot APPROVED review does not satisfy the gate', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(reviews({ login: 'dependabot[bot]', state: 'APPROVED', commitId: HEAD_SHA }))
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('a human login containing "codex" cannot spoof the gate', async () => {
    const validate = createCodexApprovalValidator(
      codexSpawn(reviews({ login: 'codex', state: 'APPROVED', commitId: HEAD_SHA }))
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('no codex approval → retryable_block; cadence left to hook.retry (no override)', async () => {
    const validate = createCodexApprovalValidator(codexSpawn([]));
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });

  test('rate-limited gh (pr view) → retryable_block, never opens the gate', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('non-rate-limit gh failure (PR not found) → terminal block', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([{ stdout: '', stderr: 'no pull requests found for branch', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('no pr_url + rate-limited workspace-branch resolution → retryable_block', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const result = await validate({
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'codex-hook',
      methodName: 'send_message',
      params: { data: {} },
      nodeId: 'node-1',
      nodeName: 'Coding',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: {},
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('retryable_block');
  });

  test('H: a head pushed between resolution and the comments fetch → retryable_block', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        { stdout: JSON.stringify({ url: PR_URL }), stderr: '', exitCode: 0 },
        {
          stdout: JSON.stringify({ number: 42, headRefOid: HEAD_SHA, url: PR_URL }),
          stderr: '',
          exitCode: 0,
        },
        {
          stdout: JSON.stringify(
            reviews({ login: 'codex[bot]', state: 'APPROVED', commitId: HEAD_SHA })
          ),
          stderr: '',
          exitCode: 0,
        },
        {
          stdout: JSON.stringify({ headRefOid: 'newcommit00000000000000000000000000' }),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('J: a transient GitHub 5xx → retryable_block, never a terminal block', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 502: bad gateway', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });

  test('J2: a 4xx auth failure (401) → terminal block, not retryable', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 401: Bad credentials', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('TOCTOU recheck with missing headRefOid → retryable_block (fail closed)', async () => {
    const validate = createCodexApprovalValidator(
      mockSpawn([
        { stdout: JSON.stringify({ url: PR_URL }), stderr: '', exitCode: 0 },
        {
          stdout: JSON.stringify({ number: 42, headRefOid: HEAD_SHA, url: PR_URL }),
          stderr: '',
          exitCode: 0,
        },
        {
          stdout: JSON.stringify(
            reviews({ login: 'codex[bot]', state: 'APPROVED', commitId: HEAD_SHA })
          ),
          stderr: '',
          exitCode: 0,
        },
        { stdout: JSON.stringify({}), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
  });
});

describe('review_posted preset (Review→Coding feedback gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  const START_MS = Date.parse('2026-05-01T00:00:00Z');
  const AFTER = '2026-05-01T12:00:00Z';
  const BEFORE = '2026-04-30T12:00:00Z';

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

  test('frozenPrUrl fallback: allows when the agent omits data.pr_url entirely', async () => {
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
      hookId: 'review-posted-hook',
      methodName: 'send_message',
      params: { target: 'Coding', message: 'fix the P2 finding', data: {} },
      nodeId: 'review-node',
      nodeName: 'Review',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: { workflowStartIso: '2026-05-01T00:00:00Z' },
      frozenPrUrl: PR_URL,
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(PR_URL);
  });

  test('frozenPrUrl absent + omitted data.pr_url → block (fail-closed)', async () => {
    const validate = createReviewPostedValidator(reviewSpawn({ url: PR_URL }, 'lsm'));
    const result = await validate({
      workspacePath: '/tmp',
      runId: 'run-1',
      hookId: 'review-posted-hook',
      methodName: 'send_message',
      params: { target: 'Coding', message: 'fix the P2 finding', data: {} },
      nodeId: 'review-node',
      nodeName: 'Review',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: { workflowStartIso: '2026-05-01T00:00:00Z' },
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('prUrl is required');
  });

  test('camelCase data.prUrl: allows when the agent passes prUrl (not pr_url)', async () => {
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
      hookId: 'review-posted-hook',
      methodName: 'send_message',
      params: { target: 'Coding', message: 'fix the P2 finding', data: { prUrl: PR_URL } },
      rawParams: { target: 'Coding', message: 'fix the P2 finding', data: { prUrl: PR_URL } },
      nodeId: 'review-node',
      nodeName: 'Review',
      sessionId: 'sess-1',
      taskId: 'task-1',
      hookLocalState: { workflowStartIso: '2026-05-01T00:00:00Z' },
      currentArtifacts: [],
      permittedExternalLookups: ['github'],
    });
    expect(result.type).toBe('allow');
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
      params: { data: {} },
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
    const validate = createReviewPostedValidator((() => {
      throw new Error('gh must not be called for a disallowed host');
    }) as unknown as SpawnFn);
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
    const validate = createReviewPostedValidator((() => {
      throw new Error('gh must not be called for a disallowed host');
    }) as unknown as SpawnFn);
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
    const ghesUrl = 'https://ghes.corp.example/acme/corp/pull/42';
    const originalBaseline: Record<string, string | undefined> = { ...process.env };
    _setStartupEnvBaselineForTesting({ ...originalBaseline, GH_HOST: 'ghes.corp.example' });
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
      _setStartupEnvBaselineForTesting(originalBaseline);
    }
  });

  test('viewer-lookup rate limit with only comment evidence → retryable_block (preserve retry)', async () => {
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

describe('runGhJson transient / timeout / truncation classification', () => {
  function hangingSpawn(): SpawnFn {
    let killFn: () => void = () => {};
    const exited = new Promise<number>((resolve) => {
      killFn = () => resolve(137);
    });
    return (() =>
      ({
        stdout: streamFromString(''),
        stderr: streamFromString(''),
        exited,
        pid: 12345,
        kill() {
          killFn();
        },
      }) as unknown as SpawnProcess) as unknown as SpawnFn;
  }

  test('helper kill-timer (timeout) → retryable, not terminal', async () => {
    const outcome = await runGhJson(['gh', 'pr', 'view'], '/tmp', hangingSpawn(), {
      timeoutMs: 40,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
    expect(outcome.error).toContain('timed out');
  });

  test('transient 5xx stderr → retryable', async () => {
    const outcome = await runGhJson(
      ['gh', 'api', 'x'],
      '/tmp',
      mockSpawn([{ stdout: '', stderr: 'HTTP 503: service unavailable', exitCode: 1 }])
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  test('connection-refused stderr → retryable (DNS/connection variant)', async () => {
    const outcome = await runGhJson(
      ['gh', 'api', 'x'],
      '/tmp',
      mockSpawn([{ stdout: '', stderr: 'dial tcp: connection refused', exitCode: 1 }])
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  test('non-JSON stdout (non-truncated, e.g. a 5xx HTML page) → retryable', async () => {
    const outcome = await runGhJson(
      ['gh', 'api', 'x'],
      '/tmp',
      mockSpawn([{ stdout: '<html>503 service unavailable</html>', stderr: '', exitCode: 0 }])
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(true);
  });

  test('truncated (>MAX_BUFFER_BYTES) stdout → terminal, not retried (no livelock)', async () => {
    const big = 'x'.repeat(MAX_BUFFER_BYTES + 1000);
    const outcome = await runGhJson(
      ['gh', 'api', 'x'],
      '/tmp',
      mockSpawn([{ stdout: big, stderr: '', exitCode: 0 }])
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBeUndefined();
    expect(outcome.error).toContain('truncated');
  });

  test('non-transient failure (PR not found) → terminal', async () => {
    const outcome = await runGhJson(
      ['gh', 'pr', 'view'],
      '/tmp',
      mockSpawn([{ stdout: '', stderr: 'no pull requests found for branch', exitCode: 1 }])
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBeUndefined();
  });
});
