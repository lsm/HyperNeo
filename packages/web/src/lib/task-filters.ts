/**
 * Shared task-filter predicates.
 *
 * Single source of truth for which `SpaceTask` rows belong in derived
 * UI groupings (e.g. the "Action" tab and the sidebar Tasks badge).
 * Centralising the rule prevents the badge count from silently drifting
 * out of sync with the list it's supposed to summarise.
 *
 * Pure function, no signals or hub calls — safe to use inside renders,
 * computed signals, and unit tests.
 */

import type { SpaceTask } from '@neokai/shared';

/**
 * Minimum shape needed by `isActionRequired` — a structural subset of
 * `SpaceTask`. Keeps fixtures and callers lightweight while still
 * benefiting from compile-time checks if the schema changes.
 */
export type ActionRequiredTaskInput = Pick<SpaceTask, 'status'>;

/**
 * Returns true when a task currently requires human action.
 *
 * The "Action" tab in `SpaceDetailPanel` and the Tasks-nav badge both
 * call this predicate, so the badge count and the visible list cannot
 * drift apart. A task is considered action-required when its status is
 * either `'review'` (awaiting approval) or `'blocked'` (any reason).
 */
export function isActionRequired(task: ActionRequiredTaskInput): boolean {
  return task.status === 'blocked' || task.status === 'review';
}

/**
 * Returns true when a task is actively progressing — not yet awaiting
 * human action and not yet in a terminal state.
 *
 * Single source of truth for the "Active" tab — used by BOTH the sidebar
 * `SpaceDetailPanel` and the main-pane `SpaceTasks` view, so the two
 * surfaces cannot disagree about which tasks are Active.
 *
 * Includes:
 * - `open`, `in_progress`: the obvious cases — work has started or is
 *   ready to start, no human gate.
 * - `approved`: a transient post-approval state. After `approve_task`,
 *   the task sits in `approved` while the post-approval sub-session
 *   runs; `mark_complete` then transitions `approved → done`. Routing
 *   `approved` to Active keeps a task stuck in this state (e.g. with
 *   `postApprovalBlockedReason` populated because dispatch failed)
 *   visible to the user. The task-detail pane's
 *   `PendingPostApprovalBanner` surfaces the actionable failure.
 *
 * Excludes:
 * - `draft`: draft tasks are not yet runnable. They appear in a separate
 *   "Drafts" grouping.
 */
export function isActiveTask(task: ActionRequiredTaskInput): boolean {
  return task.status === 'open' || task.status === 'in_progress' || task.status === 'approved';
}

/**
 * Returns true when a task is in draft status — not yet published.
 *
 * Used to group draft tasks separately from active tasks.
 */
export function isDraftTask(task: ActionRequiredTaskInput): boolean {
  return task.status === 'draft';
}
