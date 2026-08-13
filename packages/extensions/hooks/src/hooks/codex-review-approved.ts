import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { ghGetCodexApproval, githubFailureToFlow } from '../github';

/**
 * `codex_review_approved` — opt-in (off by default) gate: a codex review-bot
 * APPROVED review must exist on the run's PR (resolved from the workspace
 * branch, not a caller-supplied link). Approved → continue; not yet → retry so
 * the engine re-checks on its cadence and the handoff proceeds the moment the
 * bot posts; rate-limit → retry; terminal lookup failure → stop.
 *
 * Head-binding is relaxed vs the retired validator (any codex APPROVED review
 * counts, not only one bound to the current head SHA). It is not wired onto any
 * built-in workflow; operators opt in via a binding.
 */
export const codexReviewApprovedHook: Hook = {
  id: 'codex_review_approved',
  requiredData: [],
  run: async (_action: HookAction, ctx): Promise<HookReturn> => {
    const result = await ghGetCodexApproval(ctx);
    if (!result.ok) return githubFailureToFlow(result);
    if (result.data.approved) return { flow: 'continue' };
    return { flow: 'retry', reason: 'codex review bot approval missing for the current PR.' };
  },
};
