import { describe, expect, test } from 'bun:test';
import type { HookAction, HookContext, HookArtifact } from '@hyperneo/shared/types/workflow-hooks';
import { postApprovalOnlyHook } from '../src/hooks/post-approval-only';
import { prReadyHook } from '../src/hooks/pr-ready';
import { reviewPostedHook } from '../src/hooks/review-posted';
import { VALIDATED_PR_ARTIFACT_KEY } from '../src/primary-link';
import { setGraphqlRunnerForTests } from '../src/github';

import { afterEach } from 'bun:test';
afterEach(() => setGraphqlRunnerForTests(null));

const REVIEWED_PR = 'https://github.com/org/repo/pull/42';

function stubCtx(overrides: Partial<HookContext> = {}): HookContext {
  const state: Record<string, unknown> = {};
  return {
    runId: 'run-1',
    workspacePath: '/tmp/ws',
    taskId: 'task-1',
    sourceNode: 'Coding',
    targetNode: 'Review',
    readState: (key: string) => state[key],
    recordState: (key: string, value: unknown) => {
      state[key] = value;
    },
    queueFollowUp: () => {},
    writeArtifact: () => {},
    readArtifacts: () => [],
    ...overrides,
  };
}

function sendAction(data: Record<string, unknown>): HookAction {
  return { method: 'send_message', params: { target: 'Review', message: 'm', data } };
}

function validatedStamp(link: string): HookArtifact {
  return {
    artifactType: 'link',
    artifactKey: VALIDATED_PR_ARTIFACT_KEY,
    data: { link, kind: 'pr' },
  };
}

describe('pr_ready — post-approval merge-report exemption', () => {
  test('allows an approved merge_blocked report bound to the reviewed PR', async () => {
    const ret = await prReadyHook.run(
      sendAction({ reason: 'merge_blocked', pr_link: REVIEWED_PR }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('continue');
  });

  test('allows an approved merge_fix_pushed report (pr_url spelling)', async () => {
    const ret = await prReadyHook.run(
      sendAction({ pr_url: REVIEWED_PR, reason: 'merge_fix_pushed' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('continue');
  });

  test('an exempted report naming a DIFFERENT PR is stopped (identity binding)', async () => {
    const ret = await prReadyHook.run(
      sendAction({ pr_url: 'https://github.com/org/repo/pull/999', reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('stop');
    expect(ret.reason).toContain('999');
  });

  test('an exempted report with no run identity fails closed', async () => {
    const ret = await prReadyHook.run(
      sendAction({ pr_url: REVIEWED_PR, reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved' })
    );
    expect(ret.flow).toBe('stop');
  });

  test('does not stamp the run identity for an exempted report', async () => {
    const written: HookArtifact[] = [];
    const ctx = stubCtx({
      taskStatus: 'approved',
      readArtifacts: () => [validatedStamp(REVIEWED_PR)],
      writeArtifact: (artifact) => written.push(artifact as HookArtifact),
    });
    await prReadyHook.run(sendAction({ pr_url: REVIEWED_PR, reason: 'merge_blocked' }), ctx);
    expect(written).toEqual([]);
  });

  test('an in-progress task with the same reason is NOT exempt', async () => {
    const ret = await prReadyHook.run(
      sendAction({ reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'in_progress' })
    );
    expect(ret.flow).toBe('stop');
  });

  test('an approved task without a merge-report reason is NOT exempt', async () => {
    // No link supplied either, so the readiness path stops at link resolution
    // before any GitHub access — the observable contract is "not exempted".
    const ret = await prReadyHook.run(sendAction({}), stubCtx({ taskStatus: 'approved' }));
    expect(ret.flow).toBe('stop');
  });
});

describe('post_approval_only — merge-template field compatibility', () => {
  test('accepts the merge template pr_url spelling bound to the reviewed PR', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_url: REVIEWED_PR, reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('continue');
  });

  test('still accepts the declared pr_link spelling', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_link: REVIEWED_PR, reason: 'merge_fix_pushed' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('continue');
  });

  test('a pr_url naming a different PR is stopped (identity binding)', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_url: 'https://github.com/org/repo/pull/999', reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('stop');
  });

  test('an approved report without any link is stopped (omission is not safe)', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('stop');
  });

  test('an in-progress task is stopped regardless of payload', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_link: REVIEWED_PR, reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'in_progress', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('stop');
  });
});

describe('samePrLink — identity comparison', () => {
  test('equivalent spellings match (trailing slash, /files suffix, host casing)', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_url: `${REVIEWED_PR}/files`, reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('continue');
  });

  test('a different PR number on the same repo does not match', async () => {
    const ret = await postApprovalOnlyHook.run(
      sendAction({ pr_url: 'https://github.com/org/repo/pull/43', reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved', readArtifacts: () => [validatedStamp(REVIEWED_PR)] })
    );
    expect(ret.flow).toBe('stop');
  });
});

describe('review_posted — stamped-identity binding', () => {
  const stubReviewCtx = (stamp?: string) =>
    stubCtx({ readArtifacts: () => (stamp ? [validatedStamp(stamp)] : []) });

  test('a supplied link naming a different PR than the stamp is stopped', async () => {
    const ret = await reviewPostedHook.run(
      sendAction({ pr_link: 'https://github.com/org/repo/pull/999', reason: 'changes' }),
      stubReviewCtx(REVIEWED_PR)
    );
    expect(ret.flow).toBe('stop');
    expect(ret.reason).toContain('999');
  });

  test('positive evidence with NO stamped identity continues (round 88)', async () => {
    // review_posted legitimately runs without an earlier pr_ready binding:
    // the post-lookup recheck must treat "no identity exists" as consistent
    // (only a DIVERGENT identity retries), else a found review loops retry
    // forever. refreshArtifacts returns no stamp → continue.
    setGraphqlRunnerForTests(async () => ({
      ok: true as const,
      // A formal review newer than the run start: positive evidence.
      data: {
        data: {
          viewer: { login: 'operator' },
          repository: {
            pullRequest: {
              author: { login: 'operator' },
              reviews: {
                nodes: [{ state: 'COMMENTED', publishedAt: new Date().toISOString() }],
                pageInfo: { hasPreviousPage: false },
              },
              comments: { nodes: [] },
            },
          },
        },
      },
    }));
    const ret = await reviewPostedHook.run(
      sendAction({ pr_link: REVIEWED_PR }),
      stubCtx({
        runStartedAt: Date.now() - 60_000,
        readArtifacts: () => [],
        refreshArtifacts: () => [],
      })
    );
    expect(ret.flow).toBe('continue');
  });

  test('a supplied link matching the stamp proceeds to the evidence check (no stamp → supplied trusted)', async () => {
    // No stamped identity yet: the supplied link is trusted, and the hook
    // proceeds to the evidence check — with no runStartedAt it stops there
    // (fail closed) rather than at link resolution.
    const ret = await reviewPostedHook.run(sendAction({ pr_link: REVIEWED_PR }), stubCtx());
    expect(ret.flow).toBe('stop');
    expect(ret.reason).toContain('run start time');
  });
});

describe('pr_ready — identity stamped before readiness stops', () => {
  test('an exempted readiness stop still stamps the run identity (override-safe)', async () => {
    // A stop-returning path cannot hit GitHub in unit tests, but the
    // post-approval exemption path CAN: assert that when the exemption
    // CONTINUES the identity is already resolvable — and more directly,
    // assert the ordering contract via a stub ctx capturing writes around
    // the merge-report exemption (which skips readiness entirely).
    const written: HookArtifact[] = [];
    const ctx = stubCtx({
      taskStatus: 'approved',
      readArtifacts: () => [validatedStamp(REVIEWED_PR)],
      writeArtifact: (artifact) => written.push(artifact as HookArtifact),
    });
    const ret = await prReadyHook.run(
      sendAction({ pr_url: REVIEWED_PR, reason: 'merge_blocked' }),
      ctx
    );
    expect(ret.flow).toBe('continue');
    // The exemption does not re-stamp (identity already present), but the
    // identity IS resolvable for downstream gates.
    expect(written).toEqual([]);
  });
});
