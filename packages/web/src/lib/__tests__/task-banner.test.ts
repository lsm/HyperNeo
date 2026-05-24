import { describe, test, expect } from 'vitest';
import type { SpaceTask } from '@neokai/shared';
import {
  resolveActiveTaskBanner,
  type GateBannerSummary,
  type TaskBannerInput,
} from '../task-banner.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────

/**
 * Minimal task fixture. Only the banner-relevant fields are declared; the
 * helper reads via `Pick<SpaceTask, …>` so the object does not need the full
 * `SpaceTask` shape. We assert that via `TaskBannerInput` instead of the
 * full type.
 */
function makeTask(overrides: Partial<TaskBannerInput> = {}): TaskBannerInput {
  return {
    status: 'in_progress',
    postApprovalBlockedReason: null,
    pendingCheckpointType: null,
    workflowRunId: 'run-1',
    ...overrides,
  };
}

function gate(status: GateBannerSummary['status']): GateBannerSummary {
  return { status };
}

// ── Precedence ────────────────────────────────────────────────────────────

describe('resolveActiveTaskBanner — precedence order', () => {
  test("status='blocked' wins over every other banner signal", () => {
    const task = makeTask({
      status: 'blocked',
      postApprovalBlockedReason: 'sub-session died',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, [gate('waiting_human')])).toEqual({
      kind: 'blocked',
    });
  });

  test("status='approved' with a postApprovalBlockedReason beats task_completion + gates", () => {
    const task = makeTask({
      status: 'approved',
      postApprovalBlockedReason: 'merge failed',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, [gate('waiting_human')])).toEqual({
      kind: 'post_approval_blocked',
      reason: 'merge failed',
    });
  });

  test('task_completion checkpoint beats a waiting_human gate', () => {
    const task = makeTask({
      status: 'review',
      pendingCheckpointType: 'task_completion',
    });
    expect(resolveActiveTaskBanner(task, [gate('waiting_human')])).toEqual({
      kind: 'task_completion_pending',
    });
  });

  test('gate_pending is the lowest-priority banner', () => {
    const task = makeTask({ status: 'in_progress' });
    expect(resolveActiveTaskBanner(task, [gate('waiting_human')])).toEqual({
      kind: 'gate_pending',
      runId: 'run-1',
    });
  });

  test('returns null when no banner signal is active', () => {
    const task = makeTask({ status: 'in_progress' });
    expect(resolveActiveTaskBanner(task, [])).toBeNull();
    expect(resolveActiveTaskBanner(task, [gate('open')])).toBeNull();
    expect(resolveActiveTaskBanner(task, [gate('blocked')])).toBeNull();
  });
});

// ── Branch: post_approval_blocked ─────────────────────────────────────────

describe('post_approval_blocked branch', () => {
  test('only fires when status is `approved`', () => {
    // `review` status with a stale blocked reason must NOT promote to post_approval_blocked
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
      // With no task_completion checkpoint and no gates → null
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

// ── Branch: task_completion_pending ───────────────────────────────────────

describe('task_completion_pending branch', () => {
  test("fires regardless of task status as long as pendingCheckpointType is 'task_completion'", () => {
    for (const status of ['open', 'in_progress', 'review', 'approved', 'done'] as const) {
      const task = makeTask({
        status,
        pendingCheckpointType: 'task_completion',
        // Clear the post-approval signal so it cannot capture the 'approved' case
        postApprovalBlockedReason: null,
      });
      // `blocked` status short-circuits earlier; other statuses select this branch
      expect(resolveActiveTaskBanner(task)?.kind).toBe('task_completion_pending');
    }
  });

  test('unknown checkpoint type values are ignored — they fall through to gate/null', () => {
    // PR 5/5 narrowed `pendingCheckpointType` to `'gate' | 'task_completion' |
    // null`. If a stale daemon ever ships a different literal, this helper
    // must NOT render a banner — the unknown value falls through.
    const task = makeTask({
      pendingCheckpointType: 'legacy_unknown' as unknown as SpaceTask['pendingCheckpointType'],
    });
    expect(resolveActiveTaskBanner(task, [])).toBeNull();
  });

  test('null / undefined pendingCheckpointType does not trigger', () => {
    expect(resolveActiveTaskBanner(makeTask({ pendingCheckpointType: null }), [])).toBeNull();
  });
});

// ── Branch: gate_pending ──────────────────────────────────────────────────

describe('gate_pending branch', () => {
  test('requires a workflowRunId — standalone tasks never show a gate banner', () => {
    const task = makeTask({ workflowRunId: null });
    expect(resolveActiveTaskBanner(task, [gate('waiting_human')])).toBeNull();
  });

  test('gates=undefined is treated as "still loading" — no gate_pending yet', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, undefined)).toBeNull();
    expect(resolveActiveTaskBanner(task)).toBeNull();
  });

  test('empty gates array means loaded-but-none-waiting → null', () => {
    expect(resolveActiveTaskBanner(makeTask(), [])).toBeNull();
  });

  test('only waiting_human counts; open/blocked do not fire the banner', () => {
    const task = makeTask();
    expect(resolveActiveTaskBanner(task, [gate('open'), gate('blocked')])).toBeNull();
  });

  test('fires when any gate is waiting_human (mix of statuses is fine)', () => {
    const task = makeTask();
    expect(
      resolveActiveTaskBanner(task, [gate('open'), gate('waiting_human'), gate('blocked')])
    ).toEqual({ kind: 'gate_pending', runId: 'run-1' });
  });
});
