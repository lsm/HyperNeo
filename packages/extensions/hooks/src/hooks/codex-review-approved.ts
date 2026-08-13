import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { ghGetCodexApproval, githubFailureToFlow } from '../github';
import { getPrimaryLink } from '../primary-link';

/**
 * `codex_review_approved` — opt-in (off by default) gate: codex must have
 * approved the run's reviewed PR (the authoritative link stamped by `pr_ready`,
 * not a caller-supplied value or a branch-based guess, so a stray `GH_REPO`
 * cannot redirect the check). Approval is HEAD-SPECIFIC — an APPROVED review
 * bound to the current head, or a fresh +1 reaction posted after the head push;
 * a stale codex signal from a prior head does not satisfy the gate. Approved →
 * continue; not yet → retry so the engine re-checks on its cadence and the
 * handoff proceeds the moment codex posts; rate-limit/transient → retry;
 * terminal lookup failure → stop.
 *
 * Not wired onto any built-in workflow; operators opt in via a binding.
 */
export const codexReviewApprovedHook: Hook = {
  id: 'codex_review_approved',
  requiredData: [],
  run: async (_action: HookAction, ctx): Promise<HookReturn> => {
    const link = getPrimaryLink(ctx);
    if (!link) {
      return {
        flow: 'stop',
        reason: 'codex review approval cannot be verified: this run has no reviewed PR identity.',
      };
    }
    const result = await ghGetCodexApproval(ctx, link);
    if (!result.ok) return githubFailureToFlow(result);
    if (result.data.approved) return { flow: 'continue' };
    return { flow: 'retry', reason: 'codex review bot approval missing for the current PR.' };
  },
};
