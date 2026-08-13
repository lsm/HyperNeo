import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { dataOf, POST_APPROVAL_MERGE_REASONS } from '../action';
import { getPrimaryLink } from '../primary-link';

/**
 * `post_approval_only` — gates a `send_message` channel so it may carry ONLY a
 * post-approval merge-blocker / fix-push report: the send is allowed only while
 * the owning task is `approved` AND the message carries a post-approval merge
 * signal in `data.reason`, with the supplied PR link (`data.pr_link`, or the
 * merge template's `data.pr_url` spelling) bound to the run's reviewed PR.
 *
 * Deployed on the stable `Coding with QA` workflow's `Coding → QA` channel. That
 * route exists so the coder — reused as the merger on the Coding node — can
 * report a merge blocker to QA (the approval authority) after QA approval.
 * Without this gate the channel is also reachable during implementation, letting
 * a coder activate QA (the end node) and approve without Review ever running.
 *
 * Fails closed: a missing task-status provider (`taskStatus` undefined) blocks,
 * so the route is never spoofable from an in-progress task.
 */

function readReason(action: HookAction): string | undefined {
  const value = dataOf(action)?.reason;
  return typeof value === 'string' ? value : undefined;
}

function readSuppliedLink(action: HookAction): string | undefined {
  // `pr_link` is the declared contract, but the post-approval merge template
  // (`CODER_OWNED_MERGE_INSTRUCTIONS`) emits `data.pr_url` on its blocker /
  // fix-push sends — accept both so the report is not stopped on field name.
  const data = dataOf(action);
  const value = data?.pr_link ?? data?.pr_url;
  return typeof value === 'string' ? value : undefined;
}

export const postApprovalOnlyHook: Hook = {
  id: 'post_approval_only',
  requiredData: [
    { key: 'pr_link', type: 'link', required: true },
    { key: 'reason', type: 'string', required: true },
  ],
  run: async (action, ctx): Promise<HookReturn> => {
    if (
      ctx.taskStatus === 'approved' &&
      POST_APPROVAL_MERGE_REASONS.has(readReason(action) ?? '')
    ) {
      // Bind the blocker / fix-push handoff to the run's reviewed PR. Without
      // this, a prompt-injected post-approval coder could send a merge_blocked
      // report naming a DIFFERENT same-host PR, and the approval authority's
      // re-approval procedure would then review and approve that other PR. The
      // run's primary link is stamped only by pr_ready, so it is authoritative.
      const supplied = readSuppliedLink(action);
      if (typeof supplied !== 'string') {
        return {
          flow: 'stop',
          reason:
            'Post-approval blocker/fix handoff must carry data.pr_link (or data.pr_url) bound to the reviewed PR (omission is not safe).',
        };
      }
      const primary = getPrimaryLink(ctx);
      if (!primary) {
        return {
          flow: 'stop',
          reason:
            'Post-approval blocker handoff carries a pr_link, but this run has no reviewed PR identity to bind it to.',
        };
      }
      if (supplied !== primary) {
        return {
          flow: 'stop',
          reason: `Post-approval blocker handoff PR ${supplied} does not match this run's reviewed PR ${primary}.`,
        };
      }
      return { flow: 'continue' };
    }

    return {
      flow: 'stop',
      reason:
        'This channel is post-approval only: it carries merge-blocker / fix-push reports to the ' +
        'approval authority after the task is approved. It is not available during implementation — ' +
        'hand the PR to Review instead.',
    };
  },
};
