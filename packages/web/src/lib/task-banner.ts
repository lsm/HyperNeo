/**
 * Task-pane banner precedence helper.
 *
 * Before PR 4/5 the task pane stacked four independent banners and let CSS
 * stacking decide which the user saw first. That produced ambiguous states —
 * e.g. a blocked task with a pending gate still rendered both bands.
 *
 * `resolveActiveTaskBanner` collapses that into a single, deterministic
 * decision. Consumers render exactly one banner — the one this function
 * returns — so the UI matches the documented precedence rules in
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * §4.7.2.
 *
 * Precedence (first match wins):
 *   1. `task.status === 'blocked'`                                       → `blocked`
 *   2. `task.status === 'approved' && task.postApprovalBlockedReason`    → `post_approval_blocked`
 *   3. `task.pendingCheckpointType === 'task_completion'`                → `task_completion_pending`
 *   4. `task.workflowRunId` AND any gate is `waiting_human`              → `gate_pending`
 *   5. Otherwise                                                         → `null`
 *
 * The legacy `'completion_action'` checkpoint variant was removed in PR 5/5
 * (schema migration M104 narrowed the column CHECK to `('gate',
 * 'task_completion')`), so it is no longer reachable here.
 *
 * This file is purely derived from its inputs. No hub calls, no signals, no
 * side effects — safe to call inside render loops and unit tests.
 */

import type { SpaceTask } from '@neokai/shared';

/**
 * Minimum shape the helper needs from a task — a structural subset of
 * `SpaceTask`. Using `Pick` keeps tests lightweight (fixtures don't have to
 * satisfy the full task shape) while preventing accidental drift when new
 * banner-relevant fields are added.
 */
export type TaskBannerInput = Pick<
  SpaceTask,
  'status' | 'postApprovalBlockedReason' | 'pendingCheckpointType' | 'workflowRunId'
>;

/** Gate status as evaluated by `gate-status.ts::evaluateGateStatus`. */
export type GateBannerStatus = 'open' | 'blocked' | 'waiting_human';

export interface GateBannerSummary {
  /** Evaluated gate status. Only `'waiting_human'` triggers `gate_pending`. */
  status: GateBannerStatus;
}

/** Hook status as evaluated by `use-run-hook-states.ts::evaluateHookStatus`. */
export type HookBannerStatus = 'allowed' | 'blocked_by_hook' | 'waiting_on_hook_retry';

export interface HookBannerSummary {
  /** Evaluated hook status. Only `'blocked_by_hook'` and `'waiting_on_hook_retry'` trigger `hook_pending`. */
  status: HookBannerStatus;
  hookId?: string;
  state?: Record<string, unknown>;
}

/**
 * Discriminated result — the caller renders exactly one banner component
 * based on `kind`. `null` means no banner slot is active; the caller may
 * render nothing, or a neutral background element.
 */
export type ActiveTaskBanner =
  | { kind: 'blocked' }
  | { kind: 'post_approval_blocked'; reason: string }
  | { kind: 'task_completion_pending' }
  | { kind: 'hook_pending'; runId: string }
  | { kind: 'gate_pending'; runId: string }
  | null;

/**
 * Compute the active task-pane banner from a task plus the current gate
 * and hook summaries for the task's workflow run.
 *
 * Precedence (first match wins):
 *   1. `task.status === 'blocked'`                                       → `blocked`
 *   2. `task.status === 'approved' && task.postApprovalBlockedReason`    → `post_approval_blocked`
 *   3. `task.pendingCheckpointType === 'task_completion'`                → `task_completion_pending`
 *   4. `task.workflowRunId` AND any hook is blocked or retryable         → `hook_pending`
 *   5. `task.workflowRunId` AND any gate is `waiting_human`              → `gate_pending`
 *   6. Otherwise                                                         → `null`
 *
 * @param task      The task being viewed. Only the banner-relevant fields
 *                  are read.
 * @param hooks     Optional list of hook summaries. Pass `undefined` when
 *                  hook data is still loading — `hook_pending` will never
 *                  fire in that case.
 * @param gates     Optional list of gate summaries. Pass `undefined` when
 *                  gate data is still loading — `gate_pending` will never
 *                  fire in that case.
 */
export function resolveActiveTaskBanner(
  task: TaskBannerInput,
  hooks?: readonly HookBannerSummary[],
  gates?: readonly GateBannerSummary[]
): ActiveTaskBanner {
  if (task.status === 'blocked') {
    return { kind: 'blocked' };
  }

  if (task.status === 'approved') {
    const reason = task.postApprovalBlockedReason?.trim();
    if (reason) {
      return { kind: 'post_approval_blocked', reason };
    }
  }

  if (task.pendingCheckpointType === 'task_completion') {
    return { kind: 'task_completion_pending' };
  }

  if (
    task.workflowRunId &&
    hooks &&
    hooks.some((h) => h.status === 'blocked_by_hook' || h.status === 'waiting_on_hook_retry')
  ) {
    return { kind: 'hook_pending', runId: task.workflowRunId };
  }

  if (task.workflowRunId && gates && gates.some((g) => g.status === 'waiting_human')) {
    return { kind: 'gate_pending', runId: task.workflowRunId };
  }

  return null;
}
