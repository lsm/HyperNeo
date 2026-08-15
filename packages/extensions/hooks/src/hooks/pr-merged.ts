import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { ghGetPr, githubFailureToFlow } from '../github';
import { getPrimaryLink, samePrLink } from '../primary-link';

/**
 * `pr_merged` — the `mark_complete` merge gate. The run's reviewed PR must be
 * `MERGED` before the task may complete. `OPEN` is pending (the merge is in
 * flight → retry); `CLOSED` without merge, a missing PR identity, or a terminal
 * lookup failure is a hard stop. A rate-limited lookup retries.
 *
 * No agent-supplied input is needed — the hook reads the run's authoritative PR
 * from its artifacts — so `requiredData` is empty.
 */
export const prMergedHook: Hook = {
  id: 'pr_merged',
  requiredData: [],
  run: async (_action: HookAction, ctx): Promise<HookReturn> => {
    const link = getPrimaryLink(ctx);
    if (!link) {
      return { flow: 'stop', reason: 'Cannot verify merge: this run has no reviewed PR identity.' };
    }
    const result = await ghGetPr(ctx, link);
    if (!result.ok) return githubFailureToFlow(result);

    if (result.data.state === 'MERGED') {
      // Bind the POSITIVE decision to the identity it was made about: a
      // concurrent pr_ready replacement (the prior reviewed PR closed) can
      // swap the run's identity while this lookup was in flight — approving
      // completion for the OLD PR while the run now points at an unmerged
      // one. The re-read MUST be repo-backed (refreshArtifacts): the
      // snapshot ctx.readArtifacts() carries predates the chain and cannot
      // observe the replacement. A change re-verifies the new PR.
      const fresh = ctx.refreshArtifacts?.();
      const current = fresh ? getPrimaryLink(ctx, fresh) : undefined;
      if (current === undefined || !samePrLink(current, link)) {
        return {
          flow: 'retry',
          reason:
            "The run's reviewed PR identity changed while the merge was being verified; " +
            're-verifying against the current identity.',
        };
      }
      return { flow: 'continue' };
    }
    if (result.data.state === 'OPEN') return { flow: 'retry', reason: 'PR is not merged yet.' };
    return { flow: 'stop', reason: `PR state is ${result.data.state}; expected MERGED.` };
  },
};
