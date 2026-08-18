import { describe, test, expect } from 'vitest';
import type { SpaceTask } from '@hyperneo/shared';
import {
  resolveActiveTaskBanner,
  type HookBannerSummary,
  type TaskBannerInput,
} from '../task-banner.ts';

function makeTask(overrides: Partial<TaskBannerInput> = {}): TaskBannerInput {
  return {
    status: 'in_progress',
    postApprovalBlockedReason: null,
    pendingCheckpointType: null,
    workflowRunId: 'run-1',
    ...overrides,
  };
}

function hook(status: HookBannerSummary['status']): HookBannerSummary {
  return {
    status,
    hookId: 'h1',
    state: {
      runId: 'run-1',
      hookId: 'h1',
      version: 0,
      localState: {},
      retryCount: 0,
      createdAt: 0,
      updatedAt: 0,
      voteMaps: {},
    },
  };
}

describe('resolveActiveTaskBanner — precedence order', () => {
  test("status='blocked' wins over every other banner signal", () => {
    const task = makeTask({
      status: 'blocked',
      postApprovalBlockedReason: 'sub-session died',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, undefined)).toEqual({
      kind: 'blocked',
    });
  });

  test("status='approved' with a postApprovalBlockedReason beats task_completion", () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'merge failed',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, undefined)).toEqual({
      kind: 'post_approval_blocked',
      reason: 'merge failed',
    });
  });

  test('task_completion checkpoint fires before any hook signal', () => {
    const task = makeTask({
      status: 'review',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, [hook('blocked_by_hook')])).toEqual({
      kind: 'task_completion_pending',
    });
  });

  test('hook_pending is the lowest-priority banner (after blocked/post_approval/task_completion)', () => {
    const task = makeTask({ status: 'in_progress' });
    expect(resolveActiveTaskBanner(task, [hook('blocked_by_hook')])).toEqual({
      kind: 'hook_pending',
      runId: 'run-1',
    });
  });

  test('returns null when no banner signal is active', () => {
    const task = makeTask({ status: 'in_progress' });
    expect(resolveActiveTaskBanner(task, [])).toBeNull();
    expect(resolveActiveTaskBanner(task, undefined)).toBeNull();
  });
});

describe('post_approval_blocked branch', () => {
  test('only fires when status is `approved`', () => {
    const task = makeTask({
      status: 'review',
      postApprovalBlockedReason: 'stale reason',
    });
    expect(resolveActiveTaskBanner(task)).toBeNull();
  });

  test('requires a non-empty reason (null / undefined / whitespace fall through)', () => {
    for (const reason of [null, undefined, '', '   ', '\n\t']) {
      const task = makeTask({
        status: 'approved',
        postApprovalBlockedReason: reason,
      });
      expect(resolveActiveTaskBanner(task)).toBeNull();
    }
  });

  test('preserves the original reason verbatim (trimmed of surrounding whitespace)', () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: '  merge conflict on base branch  ',
    });
    expect(resolveActiveTaskBanner(task)).toEqual({
      kind: 'post_approval_blocked',
      reason: 'merge conflict on base branch',
    });
  });
});

describe('task_completion_pending branch', () => {
  test("fires ONLY when status is 'review' (the checkpoint is paused)", () => {
    const task = makeTask({
      status: 'review',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task)).toEqual({ kind: 'task_completion_pending' });
  });

  test("does NOT fire once status has left 'review' — even with the checkpoint field still set", () => {
    for (const status of ['open', 'in_progress', 'approved', 'done'] as const) {
      const task = makeTask({
        status,
        pendingCheckpointType: 'task_completion',
        postApprovalBlockedReason: null,
      });
      expect(resolveActiveTaskBanner(task, undefined)).toBeNull();
    }
  });

  test("'blocked' status short-circuits to the blocked banner even with a task_completion checkpoint", () => {
    const task = makeTask({
      status: 'blocked',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task)).toEqual({ kind: 'blocked' });
  });

  test('unknown checkpoint type values are ignored — they fall through to null', () => {
    const task = makeTask({
      pendingCheckpointType: 'legacy_unknown' as unknown as SpaceTask['pendingCheckpointType'],
    });
    expect(resolveActiveTaskBanner(task, undefined)).toBeNull();
  });

  test('null / undefined pendingCheckpointType does not trigger', () => {
    expect(
      resolveActiveTaskBanner(makeTask({ pendingCheckpointType: null }), undefined)
    ).toBeNull();
  });
});

describe('hook_pending branch', () => {
  test('requires a workflowRunId — standalone tasks never show a hook banner', () => {
    const task = makeTask({ workflowRunId: null });
    expect(resolveActiveTaskBanner(task, [hook('blocked_by_hook')])).toBeNull();
  });

  test('hooks=undefined is treated as "still loading" — no hook_pending yet', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, undefined)).toBeNull();
    expect(resolveActiveTaskBanner(task)).toBeNull();
  });

  test('empty hooks array means loaded-but-none-waiting → null', () => {
    expect(resolveActiveTaskBanner(makeTask(), [])).toBeNull();
  });

  test('only blocked_by_hook / waiting_on_hook_retry count; allowed does not fire', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, [hook('allowed')])).toBeNull();
  });

  test('fires when any hook is blocked_by_hook', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, [hook('blocked_by_hook')])).toEqual({
      kind: 'hook_pending',
      runId: 'run-1',
    });
  });

  test('fires when any hook is waiting_on_hook_retry', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, [hook('waiting_on_hook_retry')])).toEqual({
      kind: 'hook_pending',
      runId: 'run-1',
    });
  });
});
