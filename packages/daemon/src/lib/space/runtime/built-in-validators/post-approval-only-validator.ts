/**
 * Post-Approval-Only Built-in Validator.
 *
 * Gates a `send_message` channel so it may carry ONLY a post-approval
 * merge-blocker / fix-push report: the send is allowed only while the owning
 * task is `approved` AND the message carries a post-approval merge signal in
 * `data.reason`.
 *
 * Deployed on the stable `Coding with QA` workflow's `Coding → QA` channel.
 * That route exists so the coder — reused as the merger on the Coding node —
 * can report a merge blocker to QA (the approval authority) after QA approval.
 * Without this gate the channel is also reachable during the implementation
 * phase, letting a coder activate QA (the end node) and `approve_task` without
 * Review ever running. This mirrors the `pr_ready` post-approval exemption,
 * inverted: `pr_ready` lets the merge-reason send through its PR-readiness gate
 * only while approved; this validator lets the send through AT ALL only while
 * approved.
 *
 * Fails closed: a missing task-status provider (`taskStatus` undefined) blocks,
 * so the route is never spoofable from an in-progress task.
 */

import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';

const POST_APPROVAL_MERGE_REASONS = new Set(['merge_blocked', 'merge_fix_pushed']);

function readSendReason(context: HookExecutorContext): string | undefined {
  const data = (context.rawParams ?? context.params)?.data;
  if (data && typeof data === 'object' && 'reason' in data) {
    const reason = (data as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
  return undefined;
}

export function createPostApprovalOnlyValidator(): (
  context: HookExecutorContext
) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    if (
      context.taskStatus === 'approved' &&
      POST_APPROVAL_MERGE_REASONS.has(readSendReason(context) ?? '')
    ) {
      return { type: 'allow' };
    }
    return {
      type: 'block',
      reason:
        'This channel is post-approval only: it carries merge-blocker / fix-push reports to the ' +
        'approval authority after the task is approved. It is not available during implementation — ' +
        'hand the PR to Review instead.',
    };
  };
}
