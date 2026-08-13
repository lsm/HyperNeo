import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { isPostApprovalMergeReport, readDataString } from '../action';
import { ghGetPr, ghGetUnresolvedReviewThreads, githubFailureToFlow } from '../github';
import { getPrimaryLink, VALIDATED_PR_ARTIFACT_KEY } from '../primary-link';

/**
 * `pr_ready` — the coder→reviewer handoff gate. The PR must be OPEN, MERGEABLE,
 * in a clean-ish merge state, and free of unresolved review conversations
 * before the reviewer is activated. UNKNOWN mergeability/checks → retry (GitHub
 * still computing); anything else → stop; rate-limit → retry.
 *
 * On success the hook stamps the run's authoritative PR link as a `link/pr`
 * artifact, so downstream hooks (`post_approval_only`, `pr_merged`) can bind to
 * it via `getPrimaryLink`.
 *
 * Post-approval exemption: when the owning task is already `approved` and the
 * send carries a merge-blocker / fix-push report reason, the send is allowed
 * through without a readiness check — but only when the supplied PR link
 * matches the run's reviewed identity (`getPrimaryLink`), so the re-approval
 * authority cannot be redirected to an unrelated PR. Such a report reaches
 * this gate only on workflows without a dedicated post-approval channel
 * (Coding, Research — whose sole implementer→reviewer route is this one), and
 * it describes a PR that is by definition not ready; blocking it outright
 * would strand the approved task with no way to reach its approval authority.
 * Where a dedicated route exists (Coding with QA), `post_approval_only` gates
 * it with the same identity binding.
 */
const READY_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'BLOCKED']);
const WAIT_MS = 30_000;

export const prReadyHook: Hook = {
  id: 'pr_ready',
  requiredData: [{ key: 'pr_link', type: 'link', required: true }],
  run: async (action: HookAction, ctx): Promise<HookReturn> => {
    // Post-approval merge-blocker / fix-push report — skip the readiness check
    // (the reported PR is by definition not ready) but still bind it to the
    // run's reviewed identity: the re-approval authority must not be redirected
    // to an unrelated PR by a prompt-injected sender. Fails closed when the
    // run has no validated identity or the supplied link names another PR.
    if (isPostApprovalMergeReport(action, ctx)) {
      const supplied = readDataString(action, 'pr_link') ?? readDataString(action, 'pr_url');
      const primary = getPrimaryLink(ctx);
      if (!primary) {
        return {
          flow: 'stop',
          reason:
            'Post-approval merge report cannot be verified: this run has no reviewed PR identity ' +
            'to bind it to.',
        };
      }
      if (supplied !== primary) {
        return {
          flow: 'stop',
          reason:
            `Post-approval merge report PR ${supplied ?? '(none supplied)'} does not match this ` +
            `run's reviewed PR ${primary}.`,
        };
      }
      return { flow: 'continue' };
    }

    // requiredData declares `pr_link`, but several preserved built-in prompts
    // instruct the agent to send `pr_url`; accept both so the first handoff
    // isn't blocked on the field name. Falls back to the run's stamped identity.
    const link =
      readDataString(action, 'pr_link') ?? readDataString(action, 'pr_url') ?? getPrimaryLink(ctx);
    if (!link) {
      return { flow: 'stop', reason: 'PR is not ready for Review: no PR link supplied.' };
    }

    const pr = await ghGetPr(ctx, link);
    if (!pr.ok) return githubFailureToFlow(pr);
    if (pr.data.state !== 'OPEN') {
      return {
        flow: 'stop',
        reason: `PR is not ready for Review: state is ${pr.data.state} (expected OPEN).`,
      };
    }
    if (pr.data.mergeable === 'UNKNOWN') {
      return { flow: 'retry', reason: 'Waiting for GitHub mergeability.', retryAfterMs: WAIT_MS };
    }
    if (pr.data.mergeable !== 'MERGEABLE') {
      return {
        flow: 'stop',
        reason: `PR is not ready for Review: not mergeable (${pr.data.mergeable}).`,
      };
    }
    if (pr.data.mergeStateStatus === 'UNKNOWN') {
      return { flow: 'retry', reason: 'Waiting for GitHub merge checks.', retryAfterMs: WAIT_MS };
    }
    if (!READY_MERGE_STATES.has(pr.data.mergeStateStatus)) {
      return {
        flow: 'stop',
        reason: `PR is not ready for Review: merge checks not satisfied (${pr.data.mergeStateStatus}).`,
      };
    }

    const threads = await ghGetUnresolvedReviewThreads(ctx, link);
    if (!threads.ok) return githubFailureToFlow(threads);
    if (threads.data.length > 0) {
      return {
        flow: 'stop',
        reason:
          `PR is not ready for Review: ${threads.data.length} unresolved review conversation(s); resolve them before handoff:\n` +
          threads.data.join('\n'),
      };
    }

    // Identity-immutability check: the reserved stamp is upserted per
    // (run, node, type, key), so a re-run of pr_ready on the same node WOULD
    // overwrite it. Downstream gates (post_approval_only, pr_merged) bind to
    // that identity, so a swap to a different PR must not happen silently.
    // Allow a re-stamp only when the previously reviewed PR is no longer open
    // (a legitimate revision replacing a closed/unmerged PR); if it is still
    // OPEN, the reviewed identity stands — stop.
    const validated = getPrimaryLink(ctx);
    if (validated && validated !== link) {
      const prior = await ghGetPr(ctx, validated);
      if (!prior.ok) return githubFailureToFlow(prior);
      if (prior.data.state === 'OPEN') {
        return {
          flow: 'stop',
          reason:
            `PR is not ready for Review: this run's reviewed PR identity is already bound to ${validated} ` +
            `(still OPEN). A different PR cannot replace it mid-run; continue with the reviewed PR, ` +
            `or close it first if it genuinely needs replacing.`,
        };
      }
    }

    // Stamp the run's authoritative PR identity under an ENGINE-RESERVED key.
    // `save_artifact` rejects `__`-prefixed keys, so a same-node agent (e.g. a
    // post-approval coder reused as the merger) cannot overwrite this with a
    // different already-merged PR and swap the identity the merge gate binds to.
    ctx.writeArtifact({
      artifactType: 'link',
      artifactKey: VALIDATED_PR_ARTIFACT_KEY,
      data: { link, kind: 'pr' },
    });
    return { flow: 'continue' };
  },
};
