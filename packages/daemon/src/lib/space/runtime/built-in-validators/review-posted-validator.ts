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
    (url.includes('discussion_r') ||
      url.includes('pullrequestreview-') ||
      url.includes('issuecomment-'))
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

function githubTokenForHost(host: string): string | undefined {
  if (host !== 'github.com') {
    return (
      process.env.GH_ENTERPRISE_TOKEN ||
      process.env.GITHUB_ENTERPRISE_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN
    );
  }
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function apiPathMatches(path: string | undefined, suffix: string): boolean {
  if (!path) return false;
  try {
    return new URL(path).pathname.endsWith(suffix);
  } catch {
    return path.endsWith(suffix);
  }
}

async function githubGraphql(
  host: string,
  query: string,
  variables: Record<string, string | number | null | undefined>
): Promise<{ ok: true; json: unknown } | { ok: false }> {
  if (!trustedGithubHosts().has(host)) return { ok: false };

  const token = githubTokenForHost(host);
  if (token) {
    const endpoint =
      host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false };
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    const args = ['api', '--hostname', host, 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null || value === undefined) continue;
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    }
    const proc = Bun.spawn(['gh', ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false };
    return { ok: true, json: JSON.parse(output) };
  } catch {
    return { ok: false };
  }
}

async function githubRest(
  host: string,
  path: string
): Promise<{ ok: true; json: unknown } | { ok: false }> {
  if (!trustedGithubHosts().has(host)) return { ok: false };

  const token = githubTokenForHost(host);
  if (token) {
    const endpoint =
      host === 'github.com' ? `https://api.github.com${path}` : `https://${host}/api/v3${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false };
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  try {
    const proc = Bun.spawn(['gh', 'api', '--hostname', host, path], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { ok: false };
    return { ok: true, json: JSON.parse(output) };
  } catch {
    return { ok: false };
  }
}

async function getPrAuthorLogin(prUrl: string): Promise<string | undefined> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return undefined;

  const result = await githubGraphql(
    parsed.host,
    `
      query($owner:String!,$name:String!,$number:Int!) {
        repository(owner:$owner,name:$name) {
          pullRequest(number:$number) { author { login } }
        }
      }
    `,
    { owner: parsed.owner, name: parsed.repo, number: parsed.number }
  );
  if (!result.ok) return undefined;

  const json = result.json as {
    data?: { repository?: { pullRequest?: { author?: { login?: string } } } };
    errors?: unknown[];
  };
  if (json.errors) return undefined;
  return json.data?.repository?.pullRequest?.author?.login;
}

async function verifyReviewEvidenceOnGithub(
  prUrl: string,
  reviewUrl: string,
  sinceIso?: string,
  prAuthorLogin?: string
): Promise<'verified' | 'missing' | 'error'> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return 'error';

  const discussionMatch = reviewUrl.match(/discussion_r(\d+)/);
  const issueCommentMatch = reviewUrl.match(/issuecomment-(\d+)/);
  const reviewMatch = reviewUrl.match(/pullrequestreview-(\d+)/);
  const expectedDiscussionId = discussionMatch ? Number(discussionMatch[1]) : undefined;
  const expectedIssueCommentId = issueCommentMatch ? Number(issueCommentMatch[1]) : undefined;
  const expectedReviewId = reviewMatch ? Number(reviewMatch[1]) : undefined;
  if (!expectedDiscussionId && !expectedIssueCommentId && !expectedReviewId) return 'missing';

  const since = sinceIso ? Date.parse(sinceIso) : 0;
  const isFresh = (createdAt?: string) => {
    const t = createdAt ? Date.parse(createdAt) : Number.NaN;
    return Number.isFinite(t) && t >= since;
  };
  const matches = (node: { databaseId?: number; createdAt?: string }, expectedId?: number) =>
    expectedId !== undefined && node.databaseId === expectedId && isFresh(node.createdAt);

  if (expectedDiscussionId !== undefined) {
    const result = await githubRest(
      parsed.host,
      `/repos/${parsed.owner}/${parsed.repo}/pulls/comments/${expectedDiscussionId}`
    );
    if (result.ok) {
      const comment = result.json as {
        id?: number;
        pull_request_url?: string;
        created_at?: string;
      };
      if (
        comment.id === expectedDiscussionId &&
        apiPathMatches(comment.pull_request_url, `/pulls/${parsed.number}`) &&
        isFresh(comment.created_at)
      ) {
        return 'verified';
      }
    }
  }

  if (expectedIssueCommentId !== undefined) {
    const result = await githubRest(
      parsed.host,
      `/repos/${parsed.owner}/${parsed.repo}/issues/comments/${expectedIssueCommentId}`
    );
    if (result.ok) {
      const comment = result.json as {
        id?: number;
        issue_url?: string;
        created_at?: string;
        user?: { login?: string };
      };
      if (
        comment.id === expectedIssueCommentId &&
        apiPathMatches(comment.issue_url, `/issues/${parsed.number}`) &&
        isFresh(comment.created_at) &&
        prAuthorLogin !== undefined &&
        comment.user?.login === prAuthorLogin
      ) {
        return 'verified';
      }
    }
  }

  if (expectedReviewId !== undefined) {
    const result = await githubRest(
      parsed.host,
      `/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews/${expectedReviewId}`
    );
    if (result.ok) {
      const review = result.json as { id?: number; submitted_at?: string; submittedAt?: string };
      if (review.id === expectedReviewId && isFresh(review.submitted_at ?? review.submittedAt)) {
        return 'verified';
      }
    }
  }

  let reviewsCursor: string | undefined;
  let commentsCursor: string | undefined;
  let threadsCursor: string | undefined;

  for (;;) {
    const query = `
      query($owner:String!,$name:String!,$number:Int!,$reviewsCursor:String,$commentsCursor:String,$threadsCursor:String) {
        repository(owner:$owner,name:$name) {
          pullRequest(number:$number) {
            reviews(first:100, after:$reviewsCursor) {
              nodes { databaseId createdAt }
              pageInfo { hasNextPage endCursor }
            }
            comments(first:100, after:$commentsCursor) {
              nodes { databaseId createdAt }
              pageInfo { hasNextPage endCursor }
            }
            reviewThreads(first:100, after:$threadsCursor) {
              nodes { comments(first:100) { nodes { databaseId createdAt } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    `;

    const result = await githubGraphql(parsed.host, query, {
      owner: parsed.owner,
      name: parsed.repo,
      number: parsed.number,
      reviewsCursor,
      commentsCursor,
      threadsCursor,
    });
    if (!result.ok) return 'error';

    const json = result.json as {
      data?: {
        repository?: {
          pullRequest?: {
            reviews?: {
              nodes?: Array<{ databaseId?: number; createdAt?: string }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
            comments?: {
              nodes?: Array<{ databaseId?: number; createdAt?: string }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
            reviewThreads?: {
              nodes?: Array<{
                comments?: { nodes?: Array<{ databaseId?: number; createdAt?: string }> };
              }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          };
        };
      };
      errors?: unknown[];
    };
    if (json.errors) return 'error';
    const pr = json.data?.repository?.pullRequest;
    if (!pr) return 'error';

    if (pr.reviews?.nodes?.some((n) => matches(n, expectedReviewId))) return 'verified';
    if (pr.comments?.nodes?.some((n) => matches(n, expectedIssueCommentId))) return 'verified';
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      if (thread.comments?.nodes?.some((n) => matches(n, expectedDiscussionId))) {
        return 'verified';
      }
    }

    const nextReviewsCursor = pr.reviews?.pageInfo?.hasNextPage
      ? pr.reviews.pageInfo.endCursor
      : undefined;
    const nextCommentsCursor = pr.comments?.pageInfo?.hasNextPage
      ? pr.comments.pageInfo.endCursor
      : undefined;
    const nextThreadsCursor = pr.reviewThreads?.pageInfo?.hasNextPage
      ? pr.reviewThreads.pageInfo.endCursor
      : undefined;
    if (!nextReviewsCursor && !nextCommentsCursor && !nextThreadsCursor) return 'missing';
    reviewsCursor = nextReviewsCursor;
    commentsCursor = nextCommentsCursor;
    threadsCursor = nextThreadsCursor;
  }
}

function freshEvidenceSinceIso(ctx: HookExecutorContext): string | undefined {
  let since = ctx.workflowStartIso ? Date.parse(ctx.workflowStartIso) : 0;
  for (const artifact of ctx.currentArtifacts) {
    if (artifact.type === 'review' || artifact.type === 'review_feedback') continue;
    if (artifact.nodeId === ctx.nodeId) continue;
    const updatedAt = typeof artifact.updatedAt === 'number' ? artifact.updatedAt : 0;
    const createdAt = typeof artifact.createdAt === 'number' ? artifact.createdAt : 0;
    since = Math.max(since, updatedAt, createdAt);
  }
  return since > 0 ? new Date(since).toISOString() : undefined;
}

async function findReviewEvidence(
  ctx: HookExecutorContext
): Promise<{ reviewUrl?: string; source: string } | undefined> {
  const data = ctx.params.data as Record<string, unknown> | undefined;
  const activePrBase = extractPrBaseUrl(getActivePrUrl(ctx) ?? '');
  const evidenceSinceIso = freshEvidenceSinceIso(ctx);

  const verifyUrl = async (url: string): Promise<boolean> => {
    const reviewBase = extractPrBaseUrl(url);
    if (!reviewBase) return false;
    if (activePrBase && reviewBase !== activePrBase) return false;
    const prUrl = activePrBase ?? reviewBase;
    const prAuthorLogin = await getPrAuthorLogin(prUrl);
    const verified = await verifyReviewEvidenceOnGithub(
      prUrl,
      url,
      evidenceSinceIso,
      prAuthorLogin
    );
    return verified === 'verified';
  };

  // Immediate evidence in the message data
  if (
    data?.review_url &&
    typeof data.review_url === 'string' &&
    isValidReviewUrl(data.review_url)
  ) {
    if (!(await verifyUrl(data.review_url))) return undefined;
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
        if (!(await verifyUrl(url))) continue;
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
