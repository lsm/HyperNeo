import { describe, expect, test } from 'bun:test';
import type { HookAction, HookContext, HookArtifact } from '@hyperneo/shared/types/workflow-hooks';
import { postApprovalOnlyHook } from '../src/hooks/post-approval-only';
import { prReadyHook } from '../src/hooks/pr-ready';
import { VALIDATED_PR_ARTIFACT_KEY } from '../src/primary-link';

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
  test('allows an approved merge_blocked report without a readiness check', async () => {
    // No PR link is supplied at all — without the exemption the hook would stop
    // (and any readiness check would need live GitHub access).
    const ret = await prReadyHook.run(
      sendAction({ reason: 'merge_blocked' }),
      stubCtx({ taskStatus: 'approved' })
    );
    expect(ret.flow).toBe('continue');
  });

  test('allows an approved merge_fix_pushed report', async () => {
    const ret = await prReadyHook.run(
      sendAction({ pr_url: REVIEWED_PR, reason: 'merge_fix_pushed' }),
      stubCtx({ taskStatus: 'approved' })
    );
    expect(ret.flow).toBe('continue');
  });

  test('does not stamp the run identity for an exempted report', async () => {
    const written: HookArtifact[] = [];
    const ctx = stubCtx({
      taskStatus: 'approved',
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
