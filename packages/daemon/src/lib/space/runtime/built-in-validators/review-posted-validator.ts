/**
 * Review Posted Validator
 *
 * Built-in hook validator for the Review → Coding feedback channel.
 * Ensures that the reviewer has posted review evidence (either as an artifact
 * or embedded in the message data) before the message is delivered.
 */

import type { WorkflowHookResult } from '@neokai/shared';
import type { HookExecutorContext } from '../hook-executor';

function isValidReviewUrl(url: string): boolean {
  // Must look like a GitHub (or Enterprise) PR or review comment URL
  return /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
}

/** Extract the PR base URL (host/owner/repo/pull/N) from a full URL. */
function extractPrBaseUrl(url: string): string | undefined {
  const m = url.match(/^(https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+)/);
  return m?.[1];
}

/** Find the active PR URL from gate data (canonical source). */
function getActivePrUrl(ctx: HookExecutorContext): string | undefined {
  for (const gate of ctx.gateData ?? []) {
    const gateData = gate.data as Record<string, unknown> | undefined;
    if (typeof gateData?.pr_url === 'string') return gateData.pr_url;
  }
  return undefined;
}

function findReviewEvidence(
  ctx: HookExecutorContext
): { reviewUrl?: string; source: string } | undefined {
  const data = ctx.params.data as Record<string, unknown> | undefined;
  const activePrBase = extractPrBaseUrl(getActivePrUrl(ctx) ?? '');

  // Immediate evidence in the message data
  if (
    data?.review_url &&
    typeof data.review_url === 'string' &&
    isValidReviewUrl(data.review_url)
  ) {
    // If we know the active PR, verify the review URL is for the same PR
    if (activePrBase) {
      const reviewBase = extractPrBaseUrl(data.review_url);
      if (reviewBase !== activePrBase) return undefined;
    }
    return { reviewUrl: data.review_url, source: 'message_data' };
  }

  // Look through recent artifacts for a fresh review artifact.
  // currentArtifacts is sorted by updatedAt descending. If the most recent
  // artifact is non-review work (e.g., a new code revision), any older review
  // artifact is considered stale for this cycle.
  for (const artifact of ctx.currentArtifacts) {
    if (artifact.type === 'review' || artifact.type === 'review_feedback') {
      const artifactData = artifact.data as Record<string, unknown> | undefined;
      const url = artifactData?.review_url;
      if (typeof url === 'string' && isValidReviewUrl(url)) {
        if (activePrBase) {
          const reviewBase = extractPrBaseUrl(url);
          if (reviewBase !== activePrBase) continue;
        }
        return { reviewUrl: url, source: 'artifact' };
      }
    } else {
      break;
    }
  }

  return undefined;
}

/**
 * Main validator entry point.
 */
export async function reviewPostedValidator(ctx: HookExecutorContext): Promise<WorkflowHookResult> {
  const evidence = findReviewEvidence(ctx);

  if (!evidence) {
    return {
      type: 'block',
      reason:
        'No review evidence found. Post a GitHub review on the PR and include ' +
        '`data: { review_url: "<github-pull-url>" }` in your message, or save a review artifact first.',
    };
  }

  return {
    type: 'allow',
    message: `Review evidence verified (${evidence.source}).`,
  };
}
