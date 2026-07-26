/**
 * PR Merged Built-in Validator
 *
 * The symmetric counterpart to `pr_ready`. `pr_ready` blocks the
 * coder→reviewer handoff until the PR is *ready* (open + mergeable + clean).
 * `pr_merged` blocks the post-approval reviewer's `mark_complete`
 * (`approved → done`) until the PR is actually *merged* — i.e. until the
 * delivery to the base branch is confirmed.
 *
 * This enforces the merge-conflict routing contract deterministically: a task
 * can never be marked complete for an unmerged PR. When the PR has unresolved
 * merge conflicts, the block remediation directs the reviewer to route the
 * conflict back to the coder (the upstream implementation node) rather than
 * escalating routine coder-owned work to a human.
 */

import type { WorkflowHookResult } from '@hyperneo/shared';
import type { HookExecutorContext } from '../hook-executor';
import { parsePrUrl } from '../parse-pr-url';
import {
  commandFailureToHookResult,
  extractPrUrlFromArtifacts,
  extractPrUrlFromParams,
  extractTemplatePrUrl,
  remainingTimeoutMs,
  resolveCurrentBranchPrUrl,
  runCommand,
  type CommandFailure,
} from './gh-lookup-helpers';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PrMergedView {
  url: string;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}

const BLOCK_PREFIX = 'PR is not merged';

/** States that indicate the PR head conflicts with the base branch. */
const CONFLICT_MERGE_STATE = new Set(['DIRTY']);
const CONFLICT_MERGEABLE = new Set(['CONFLICTING']);

export function createPrMergedValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    const deadlineMs = Date.now() + DEFAULT_TIMEOUT_MS;
    const prUrlResult = await resolvePrUrl(context, spawnImpl, deadlineMs);
    if (!prUrlResult.success) {
      return commandFailureToHookResult(prUrlResult, BLOCK_PREFIX);
    }
    const prUrl = prUrlResult.prUrl;

    const prMeta = parsePrUrl(prUrl);
    if (!prMeta) {
      return {
        type: 'block',
        reason: `${BLOCK_PREFIX}: unable to parse GitHub PR URL: ${prUrl}`,
      };
    }

    // gh pr view fields are GraphQL PullRequest fields in the GitHub CLI, so a
    // rate-limit probe uses the `graphql` resource window rather than REST `core`.
    const prView = await runCommand<PrMergedView>(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      context.workspacePath,
      remainingTimeoutMs(deadlineMs),
      spawnImpl,
      { hostHint: prMeta.host, resourceHint: 'graphql' }
    );
    if (!prView.success) {
      return commandFailureToHookResult(prView, BLOCK_PREFIX);
    }

    const prJson = prView.data;

    if (prJson.state === 'MERGED') {
      return {
        type: 'allow',
        data: { pr_url: prJson.url, merged: true },
      };
    }

    // A CLOSED PR is a definitive terminal state — it will never be merged via
    // this PR, so block regardless of the (possibly transient UNKNOWN) mergeable
    // field. CLOSED must be checked before UNKNOWN, otherwise a closed PR whose
    // mergeability GitHub hasn't finished computing would retryable-block and
    // loop on the 30s backoff instead of failing fast.
    if (prJson.state === 'CLOSED') {
      return {
        type: 'block',
        reason: `${BLOCK_PREFIX}: PR is CLOSED without being merged — investigate why the PR was closed instead of merged before completing the task.`,
      };
    }

    // GitHub computes mergeability asynchronously; a transient UNKNOWN right
    // after a push/merge attempt should back off, not hard-block.
    if (prJson.mergeable === 'UNKNOWN') {
      return {
        type: 'retryable_block',
        reason: 'Waiting for GitHub mergeability/checks',
        retryAfterMs: 30_000,
      };
    }

    const hasConflict =
      CONFLICT_MERGEABLE.has(prJson.mergeable) || CONFLICT_MERGE_STATE.has(prJson.mergeStateStatus);
    if (hasConflict) {
      return {
        type: 'block',
        reason:
          `${BLOCK_PREFIX}: PR has unresolved merge conflicts ` +
          `(mergeable: ${prJson.mergeable ?? 'unknown'}, mergeStateStatus: ${prJson.mergeStateStatus ?? 'unknown'}). ` +
          'Do NOT mark the task complete and do NOT escalate a routine merge conflict to a human — ' +
          'merge conflicts are coder-owned work. Route the conflict back to the upstream implementation ' +
          'node (Coding in a Coding workflow, Research in a Research workflow) with the conflicting files ' +
          'and retry instructions: rebase onto the latest base branch, resolve the listed conflicts, run ' +
          'the affected tests, then push to update the PR branch, and report back to Review for a re-merge.',
      };
    }

    // Open, not merged, no conflict — the reviewer has not run the merge yet.
    return {
      type: 'block',
      reason:
        `${BLOCK_PREFIX}: PR state is ${prJson.state ?? 'unknown'} ` +
        `(mergeStateStatus: ${prJson.mergeStateStatus ?? 'unknown'}). ` +
        'Merge the PR (gh pr merge --squash) before marking the task complete.',
    };
  };
}

/**
 * Resolves the PR URL to verify. `mark_complete` carries no `pr_url` param, so
 * unlike `pr_ready` this falls back to the run's artifacts (where the reviewer
 * records the PR URL before approval) before the current branch.
 *
 * Single-PR assumption: this reads the most-recent `pr_url`/`prUrl` artifact.
 * `dispatchPostApproval` resolves the merge kickoff's `{{pr_url}}` from the
 * last-*created* artifact, while the hook engine supplies artifacts ordered by
 * `updatedAt`. For the standard append-based per-cycle flow — each review cycle
 * creates a fresh result artifact via `append: true` and never upserts it —
 * `createdAt` and `updatedAt` move together, so both orderings select the same
 * (latest-cycle) PR, and the URL validated here is the one the reviewer was told
 * to merge. The step-6 merge audit artifact uses `merged_pr_url` (not `pr_url`),
 * so it is skipped. Only a run carrying multiple distinct `pr_url` values with
 * out-of-order updates could make the two selections diverge; that is not a
 * supported configuration for these workflows.
 */
async function resolvePrUrl(
  context: HookExecutorContext,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<
  | { success: true; prUrl: string }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const boundedPrUrl = extractPrUrlFromParams(context.params);
  if (boundedPrUrl) return { success: true, prUrl: boundedPrUrl };

  const rawPrUrl = context.rawParams ? extractPrUrlFromParams(context.rawParams) : undefined;
  if (rawPrUrl) return { success: true, prUrl: rawPrUrl };

  const templatePrUrl = extractTemplatePrUrl(context);
  if (templatePrUrl) return { success: true, prUrl: templatePrUrl };

  const artifactPrUrl = extractPrUrlFromArtifacts(context.currentArtifacts);
  if (artifactPrUrl) return { success: true, prUrl: artifactPrUrl };

  // Last resort: the current branch's PR. Fail-closed if nothing is resolvable
  // — a Review-node mark_complete should always have a PR, so an unresolvable
  // URL surfaces a real problem rather than silently completing the task.
  const fallback = await resolveCurrentBranchPrUrl(context, spawnImpl, deadlineMs);
  if (!fallback.success) {
    return {
      success: false,
      error: `no PR URL resolved to verify merge (${fallback.error})`,
      rateLimited: fallback.rateLimited,
      retryAfterMs: fallback.retryAfterMs,
    };
  }
  return { success: true, prUrl: fallback.prUrl };
}
