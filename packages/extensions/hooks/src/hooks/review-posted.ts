import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { readDataString } from '../action';
import { ghGetReviewEvidence, githubFailureToFlow } from '../github';
import { getPrimaryLink, samePrLink } from '../primary-link';

/**
 * `review_posted` — the Review→Coding feedback gate. The channel only opens
 * once fresh GitHub review evidence has landed since the run started: a formal
 * review (APPROVED / CHANGES_REQUESTED), or — on an own PR, since GitHub blocks
 * self-APPROVE — a PR conversation comment. Otherwise stop; rate-limit → retry.
 *
 * The run-start window comes from `ctx.runStartedAt`; fail-closed if it is
 * unknown. The PR link is read from `data.pr_link` / `data.review_link` (the
 * reviewer's payload), falling back to the run's stamped primary link.
 */
export const reviewPostedHook: Hook = {
  id: 'review_posted',
  requiredData: [{ key: 'pr_link', type: 'link', required: false }],
  run: async (action: HookAction, ctx): Promise<HookReturn> => {
    // Bind the evidence to the run's STAMPED identity: once pr_ready has
    // stamped a reviewed PR, a supplied link naming a different PR (accidental
    // or prompt-injected swap) must not redirect the gate — a fresh review on
    // PR B cannot satisfy evidence for PR A. Before the first stamp, a
    // supplied link is trusted (it is the reviewer naming the PR under
    // review).
    const primary = getPrimaryLink(ctx);
    const supplied =
      readDataString(action, 'pr_link') ??
      readDataString(action, 'pr_url') ??
      readDataString(action, 'review_link');
    let link: string | undefined;
    if (primary) {
      if (supplied && !samePrLink(supplied, primary)) {
        return {
          flow: 'stop',
          reason:
            `No fresh GitHub review evidence: the supplied PR ${supplied} does not match this ` +
            `run's reviewed PR ${primary}.`,
        };
      }
      link = primary;
    } else {
      link = supplied;
    }
    if (!link) {
      return { flow: 'stop', reason: 'No fresh GitHub review evidence: no PR link to check.' };
    }
    if (!ctx.runStartedAt) {
      return {
        flow: 'stop',
        reason: 'No fresh GitHub review evidence: run start time is unknown.',
      };
    }
    const sinceIso = new Date(ctx.runStartedAt).toISOString();

    const evidence = await ghGetReviewEvidence(ctx, link, sinceIso);
    if (!evidence.ok) return githubFailureToFlow(evidence);

    const { formalReviewCount, commentEvidenceCount, ownPr } = evidence.data;
    if (formalReviewCount >= 1 || (ownPr && commentEvidenceCount >= 1)) {
      // Bind the POSITIVE decision to the identity it was made about: a
      // concurrent pr_ready replacement can swap the run's identity while
      // this lookup was in flight — approving feedback for the OLD PR while
      // the run now points at a different one. The re-read MUST be
      // repo-backed (refreshArtifacts), mirroring pr_merged; a change
      // retries and re-verifies the new identity.
      const fresh = ctx.refreshArtifacts?.();
      const current = fresh ? getPrimaryLink(ctx, fresh) : undefined;
      // Only a DIVERGENT identity retries: these hooks legitimately run
      // before any pr_ready stamp (no __pr_validated__ exists yet), and
      // requiring one would retry forever on a valid positive result.
      if (current !== undefined && !samePrLink(current, link)) {
        return {
          flow: 'retry',
          reason:
            "The run's reviewed PR identity changed while the evidence was being fetched; " +
            're-evaluating against the current identity.',
        };
      }
      return { flow: 'continue' };
    }
    return {
      flow: 'stop',
      reason: 'No fresh GitHub review evidence: post a visible review before sending feedback.',
    };
  },
};
