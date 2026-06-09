/**
 * Review Posted Validator
 *
 * Built-in hook validator for the Review → Coding feedback channel.
 * Ensures that the reviewer has posted review evidence (either as an artifact
 * or embedded in the message data) before the message is delivered.
 */

import type { WorkflowHookResult } from '@neokai/shared';
import type { HookExecutorContext } from '../hook-executor';

function findReviewEvidence(
  ctx: HookExecutorContext
): { reviewUrl?: string; source: string } | undefined {
  const data = ctx.params.data as Record<string, unknown> | undefined;

  // Immediate evidence in the message data
  if (data?.review_url && typeof data.review_url === 'string') {
    return { reviewUrl: data.review_url, source: 'message_data' };
  }

  // Look through recent artifacts for a review artifact
  for (const artifact of ctx.currentArtifacts) {
    if (artifact.type === 'review' || artifact.type === 'review_feedback') {
      const artifactData = artifact.data as Record<string, unknown> | undefined;
      if (artifactData?.review_url && typeof artifactData.review_url === 'string') {
        return { reviewUrl: artifactData.review_url as string, source: 'artifact' };
      }
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
        '`data: { review_url: "..." }` in your message, or save a review artifact first.',
    };
  }

  return {
    type: 'allow',
    message: `Review evidence verified (${evidence.source}).`,
  };
}
