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
  // Must reference a concrete GitHub PR review/comment, not just the PR base URL.
  return (
    /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/.test(url) &&
    (url.includes('discussion_r') || url.includes('pullrequestreview-'))
  );
}

function parsePrUrl(
  url: string
): { host: string; owner: string; repo: string; number: number; baseUrl: string } | undefined {
  const m = url.match(/^(https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+))/);
  if (!m) return undefined;
  return { baseUrl: m[1], host: m[2], owner: m[3], repo: m[4], number: Number(m[5]) };
}

/** Extract the PR base URL (host/owner/repo/pull/N) from a full URL. */
function extractPrBaseUrl(url: string): string | undefined {
  return parsePrUrl(url)?.baseUrl;
}

/** Find the active PR URL from gate data (canonical source). */
function getActivePrUrl(ctx: HookExecutorContext): string | undefined {
  for (const gate of ctx.gateData ?? []) {
    const gateData = gate.data as Record<string, unknown> | undefined;
    if (typeof gateData?.pr_url === 'string') return gateData.pr_url;
  }
  return undefined;
}

function trustedGithubHosts(): Set<string> {
  const trustedHosts = new Set(['github.com']);
  const ghHost = process.env.GH_HOST;
  if (ghHost) trustedHosts.add(ghHost);
  const extraHosts = process.env.NEOKAI_TRUSTED_GITHUB_HOSTS;
  if (extraHosts) {
    for (const h of extraHosts.split(',')) {
      const trimmed = h.trim();
      if (trimmed) trustedHosts.add(trimmed);
    }
  }
  return trustedHosts;
}

async function verifyReviewEvidenceOnGithub(
  prUrl: string,
  sinceIso?: string
): Promise<'verified' | 'missing' | 'error'> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return 'error';
  if (!trustedGithubHosts().has(parsed.host)) return 'error';

  const query = `
    query($owner:String!,$name:String!,$number:Int!) {
      repository(owner:$owner,name:$name) {
        pullRequest(number:$number) {
          reviews(first:100) { nodes { createdAt } }
          comments(first:100) { nodes { createdAt } }
          reviewThreads(first:100) {
            nodes { comments(first:100) { nodes { createdAt } } }
          }
        }
      }
    }
  `;

  const token =
    parsed.host === 'github.com'
      ? process.env.GITHUB_TOKEN || process.env.GH_TOKEN
      : process.env.GH_ENTERPRISE_TOKEN ||
        process.env.GITHUB_ENTERPRISE_TOKEN ||
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN;
  if (!token) return 'error';

  const endpoint =
    parsed.host === 'github.com'
      ? 'https://api.github.com/graphql'
      : `https://${parsed.host}/api/graphql`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { owner: parsed.owner, name: parsed.repo, number: parsed.number },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return 'error';
    const json = (await res.json()) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviews?: { nodes?: Array<{ createdAt?: string }> };
            comments?: { nodes?: Array<{ createdAt?: string }> };
            reviewThreads?: {
              nodes?: Array<{ comments?: { nodes?: Array<{ createdAt?: string }> } }>;
            };
          };
        };
      };
      errors?: unknown[];
    };
    if (json.errors) return 'error';
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return 'error';
    const since = sinceIso ? Date.parse(sinceIso) : 0;
    const isFresh = (createdAt?: string) => {
      const t = createdAt ? Date.parse(createdAt) : Number.NaN;
      return Number.isFinite(t) && t >= since;
    };
    if (pr.reviews?.nodes?.some((n) => isFresh(n.createdAt))) return 'verified';
    if (pr.comments?.nodes?.some((n) => isFresh(n.createdAt))) return 'verified';
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      if (thread.comments?.nodes?.some((n) => isFresh(n.createdAt))) return 'verified';
    }
    return 'missing';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timeout);
  }
}

async function findReviewEvidence(
  ctx: HookExecutorContext
): Promise<{ reviewUrl?: string; source: string } | undefined> {
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
      const verified = await verifyReviewEvidenceOnGithub(activePrBase, ctx.workflowStartIso);
      if (verified !== 'verified') return undefined;
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
          const verified = await verifyReviewEvidenceOnGithub(activePrBase, ctx.workflowStartIso);
          if (verified !== 'verified') continue;
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
  const evidence = await findReviewEvidence(ctx);

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
