import type { HookAction, HookContext } from '@hyperneo/shared/types/workflow-hooks';

/**
 * The `data.reason` values the post-approval merge template
 * (`CODER_OWNED_MERGE_INSTRUCTIONS`) uses to label its blocker / fix-push
 * reports to the approval authority. Shared by `pr_ready` (which exempts such
 * reports from its readiness gate) and `post_approval_only` (which only admits
 * them).
 */
export const POST_APPROVAL_MERGE_REASONS: ReadonlySet<string> = new Set([
  'merge_blocked',
  'merge_fix_pushed',
]);

/**
 * True when this action is a post-approval merge-blocker / fix-push report:
 * the owning task is already `approved` and the message carries one of the
 * {@link POST_APPROVAL_MERGE_REASONS} signals. Such a report describes a PR
 * that is by definition NOT ready — a readiness gate must not block it.
 */
export function isPostApprovalMergeReport(action: HookAction, ctx: HookContext): boolean {
  if (ctx.taskStatus !== 'approved') return false;
  const reason = dataOf(action)?.reason;
  return typeof reason === 'string' && POST_APPROVAL_MERGE_REASONS.has(reason);
}

/** Read the `data` object off an action (prefers rawParams, falls back to bounded params). */
export function dataOf(action: HookAction): Record<string, unknown> | undefined {
  const data = action.rawParams?.data ?? action.params.data;
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/** Read a string field from the action's `data` object. */
export function readDataString(action: HookAction, key: string): string | undefined {
  const value = dataOf(action)?.[key];
  return typeof value === 'string' ? value : undefined;
}
