import type { Hook, HookAction, HookReturn } from '@hyperneo/shared/types/workflow-hooks';
import { readDataString } from '../action';
import { ghGetPr, ghGetUnresolvedReviewThreads, githubFailureToFlow } from '../github';
import { getPrimaryLink } from '../primary-link';

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
 * The retired validator carried a post-approval exemption; v2 drops it —
 * post-approval merge-blocker traffic now flows over a separate `Coding → QA`
 * channel gated by `post_approval_only`, so this hook only ever sees the
 * implementation handoff.
 */
const READY_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'BLOCKED']);
const WAIT_MS = 30_000;

export const prReadyHook: Hook = {
  id: 'pr_ready',
  requiredData: [{ key: 'pr_link', type: 'link', required: true }],
  run: async (action: HookAction, ctx): Promise<HookReturn> => {
    const link = readDataString(action, 'pr_link') ?? getPrimaryLink(ctx);
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

    // Stamp the run's authoritative PR identity under an ENGINE-RESERVED key.
    // `save_artifact` rejects `__`-prefixed keys, so a same-node agent (e.g. a
    // post-approval coder reused as the merger) cannot overwrite this with a
    // different already-merged PR and swap the identity the merge gate binds to.
    ctx.writeArtifact({ artifactType: 'link', artifactKey: '__pr_validated__', data: { link } });
    return { flow: 'continue' };
  },
};
