/**
 * Review Approval Validator
 *
 * Built-in hook validator for reviewer approval and multi-reviewer voting flows.
 * Handles both single-reviewer (Review -> QA) and multi-reviewer (Plan Review ->
 * Task Dispatcher) scenarios via templateData configuration.
 *
 * Vote accumulation uses hook-local state with transactional deep-merge.  A block
 * response may carry `state` so the vote is persisted even when the threshold has
 * not yet been reached.
 */

import type { WorkflowHookResult } from '@neokai/shared';
import type { HookExecutorContext } from '../hook-executor';

export interface ReviewApprovalTemplateData {
  /** Number of approvals required to pass. */
  threshold?: number;
  /** Key in params.data that holds the vote map. */
  voteKey?: string;
  /** Value that counts as an approval. */
  voteMatch?: string;
  /** Whether a rejection vote resets accumulated state. */
  resetOnRejection?: boolean;
  /** Whether codex[bot] approval is also required. */
  requireCodex?: boolean;
  /** Timeout window for codex approval in ms (default 10 min). */
  codexTimeoutMs?: number;
}

function getTemplateData(ctx: HookExecutorContext): ReviewApprovalTemplateData {
  return (ctx.templateData ?? {}) as ReviewApprovalTemplateData;
}

function extractIncomingVotes(
  data: Record<string, unknown> | undefined,
  voteKey: string,
  agentName: string
): Record<string, unknown> | undefined {
  if (!data) return undefined;

  // Map-style votes: { approvals: { architecture: "approved" } }
  const mapVotes = data[voteKey];
  if (mapVotes && typeof mapVotes === 'object' && !Array.isArray(mapVotes)) {
    return mapVotes as Record<string, unknown>;
  }

  // Boolean-style vote: { approved: true }
  // Use agentName as key so multiple reviewers don't collide.
  if (data.approved === true) {
    return { [agentName]: 'approved' };
  }

  return undefined;
}

function countApprovals(votes: Record<string, unknown>, voteMatch: string): number {
  return Object.values(votes).filter((v) => v === voteMatch).length;
}

function hasRejection(votes: Record<string, unknown>): boolean {
  return Object.values(votes).some(
    (v) => v === 'rejected' || v === 'reject' || v === 'denied' || v === 'deny'
  );
}

function getVotes(state: Record<string, unknown>, voteKey: string): Record<string, unknown> {
  const raw = state[voteKey];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function findPrUrl(ctx: HookExecutorContext): string | undefined {
  // Gate data is the canonical source for the active PR URL
  for (const gate of ctx.gateData ?? []) {
    const gateData = gate.data as Record<string, unknown> | undefined;
    if (typeof gateData?.pr_url === 'string') return gateData.pr_url;
  }

  const data = ctx.params.data as Record<string, unknown> | undefined;
  if (typeof data?.pr_url === 'string') return data.pr_url;
  if (typeof ctx.hookLocalState._pr_url === 'string') return ctx.hookLocalState._pr_url as string;

  // Fall back to artifacts (may contain stale URLs from prior cycles)
  for (const artifact of ctx.currentArtifacts) {
    const artifactData = artifact.data as Record<string, unknown> | undefined;
    if (typeof artifactData?.pr_url === 'string') return artifactData.pr_url;
  }

  return undefined;
}

function parsePrUrl(
  url: string
): { owner: string; repo: string; number: number; host: string } | null {
  const m = url.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { host: m[1], owner: m[2], repo: m[3], number: Number(m[4]) };
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

async function githubGraphql(
  host: string,
  query: string,
  variables: Record<string, string | number | boolean | null | undefined>
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
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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
      args.push(
        typeof value === 'number' || typeof value === 'boolean' ? '-F' : '-f',
        `${key}=${value}`
      );
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

/**
 * Check GitHub for a codex[bot] +1 reaction on the PR body, issue comments,
 * or review comments. Uses the GraphQL API to query all reaction locations
 * in a single request.
 *
 * Returns status 'approved' if found, 'waiting' if not, 'error' on failure,
 * plus the current PR head SHA when available.
 */
async function checkCodexApproval(
  prUrl: string,
  sinceMs: number | 'head' | undefined
): Promise<{ status: 'approved' | 'waiting' | 'error'; headSha?: string }> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return { status: 'error' };

  let commentsCursor: string | undefined;
  let threadsCursor: string | undefined;
  let headSha: string | undefined;
  let commentsDone = false;
  let threadsDone = false;

  for (;;) {
    const query = `
      query($owner:String!,$name:String!,$number:Int!,$commentsCursor:String,$threadsCursor:String,$includeComments:Boolean!,$includeThreads:Boolean!) {
        repository(owner:$owner,name:$name) {
          pullRequest(number:$number) {
            headRefOid
            commits(last:1) { nodes { commit { committedDate } } }
            reactions(first:100) {
              nodes { content createdAt user { login } }
            }
            comments(first:100, after:$commentsCursor) @include(if:$includeComments) {
              nodes {
                reactions(first:100) {
                  nodes { content createdAt user { login } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
            reviewThreads(first:100, after:$threadsCursor) @include(if:$includeThreads) {
              nodes {
                id
                comments(first:100) {
                  nodes {
                    reactions(first:100) {
                      nodes { content createdAt user { login } }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
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
      commentsCursor,
      threadsCursor,
      includeComments: !commentsDone,
      includeThreads: !threadsDone,
    });
    if (!result.ok) return { status: 'error', headSha };

    const json = result.json as {
      data?: {
        repository?: {
          pullRequest?: {
            headRefOid?: string;
            commits?: { nodes?: Array<{ commit?: { committedDate?: string } }> };
            reactions?: {
              nodes?: Array<{ content?: string; createdAt?: string; user?: { login?: string } }>;
            };
            comments?: {
              nodes?: Array<{
                reactions?: {
                  nodes?: Array<{
                    content?: string;
                    createdAt?: string;
                    user?: { login?: string };
                  }>;
                };
              }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
            reviewThreads?: {
              nodes?: Array<{
                id?: string;
                comments?: {
                  nodes?: Array<{
                    reactions?: {
                      nodes?: Array<{
                        content?: string;
                        createdAt?: string;
                        user?: { login?: string };
                      }>;
                    };
                  }>;
                  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
                };
              }>;
              pageInfo?: { hasNextPage?: boolean; endCursor?: string };
            };
          };
        };
      };
      errors?: unknown[];
    };

    if (json.errors) return { status: 'error', headSha };

    const pr = json.data?.repository?.pullRequest;
    if (!pr) return { status: 'error', headSha };

    headSha = pr.headRefOid;
    const headCommittedAt = pr.commits?.nodes?.[0]?.commit?.committedDate;
    const headCommittedMs = headCommittedAt ? Date.parse(headCommittedAt) : Number.NaN;
    const since =
      sinceMs === 'head'
        ? Number.isFinite(headCommittedMs)
          ? headCommittedMs
          : Number.POSITIVE_INFINITY
        : (sinceMs ?? Number.POSITIVE_INFINITY);

    const isFreshCodexPlusOne = (r: {
      content?: string;
      createdAt?: string;
      user?: { login?: string };
    }): boolean => {
      const createdAt = r.createdAt ? Date.parse(r.createdAt) : Number.NaN;
      return (
        (r.user?.login === 'codex[bot]' || r.user?.login === 'chatgpt-codex-connector[bot]') &&
        r.content === 'THUMBS_UP' &&
        Number.isFinite(createdAt) &&
        createdAt >= since
      );
    };

    // PR body reactions
    if (pr.reactions?.nodes?.some(isFreshCodexPlusOne)) return { status: 'approved', headSha };

    // Issue comments
    for (const comment of pr.comments?.nodes ?? []) {
      if (comment.reactions?.nodes?.some(isFreshCodexPlusOne)) {
        return { status: 'approved', headSha };
      }
    }

    // Review comments. Fetch replies beyond GraphQL's first 100 comments with per-thread calls.
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        if (comment.reactions?.nodes?.some(isFreshCodexPlusOne)) {
          return { status: 'approved', headSha };
        }
      }
      let threadCommentsCursor = thread.comments?.pageInfo?.hasNextPage
        ? thread.comments.pageInfo.endCursor
        : undefined;
      while (thread.id && threadCommentsCursor) {
        const threadResult = await githubGraphql(
          parsed.host,
          `
            query($threadId:ID!,$commentsCursor:String) {
              node(id:$threadId) {
                ... on PullRequestReviewThread {
                  comments(first:100, after:$commentsCursor) {
                    nodes {
                      reactions(first:100) {
                        nodes { content createdAt user { login } }
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }
          `,
          { threadId: thread.id, commentsCursor: threadCommentsCursor }
        );
        if (!threadResult.ok) return { status: 'error', headSha };
        const threadJson = threadResult.json as {
          data?: {
            node?: {
              comments?: {
                nodes?: Array<{
                  reactions?: {
                    nodes?: Array<{
                      content?: string;
                      createdAt?: string;
                      user?: { login?: string };
                    }>;
                  };
                }>;
                pageInfo?: { hasNextPage?: boolean; endCursor?: string };
              };
            };
          };
          errors?: unknown[];
        };
        if (threadJson.errors) return { status: 'error', headSha };
        const comments = threadJson.data?.node?.comments;
        for (const comment of comments?.nodes ?? []) {
          if (comment.reactions?.nodes?.some(isFreshCodexPlusOne)) {
            return { status: 'approved', headSha };
          }
        }
        threadCommentsCursor = comments?.pageInfo?.hasNextPage
          ? comments.pageInfo.endCursor
          : undefined;
      }
    }

    if (!commentsDone) {
      commentsCursor = pr.comments?.pageInfo?.hasNextPage
        ? pr.comments.pageInfo.endCursor
        : undefined;
      commentsDone = !commentsCursor;
    }
    if (!threadsDone) {
      threadsCursor = pr.reviewThreads?.pageInfo?.hasNextPage
        ? pr.reviewThreads.pageInfo.endCursor
        : undefined;
      threadsDone = !threadsCursor;
    }
    if (commentsDone && threadsDone) return { status: 'waiting', headSha };
  }
}

/**
 * Main validator entry point.
 */
export async function reviewApprovalValidator(
  ctx: HookExecutorContext
): Promise<WorkflowHookResult> {
  const template = getTemplateData(ctx);
  const threshold = typeof template.threshold === 'number' ? template.threshold : 1;
  const voteKey = typeof template.voteKey === 'string' ? template.voteKey : 'approvals';
  const voteMatch = typeof template.voteMatch === 'string' ? template.voteMatch : 'approved';
  const resetOnRejection = template.resetOnRejection !== false;

  const data = ctx.params.data as Record<string, unknown> | undefined;
  const state = ctx.hookLocalState;

  // Merge incoming votes into existing state
  const currentVotes = getVotes(state, voteKey);
  const incoming = extractIncomingVotes(data, voteKey, ctx.agentName);

  let mergedVotes = { ...currentVotes };
  if (incoming) {
    for (const [key, value] of Object.entries(incoming)) {
      mergedVotes[key] = value;
    }
  }

  // Handle rejection reset — use null so deepMerge overwrites instead of merging
  if (resetOnRejection && hasRejection(mergedVotes)) {
    return {
      type: 'block',
      reason: 'Approval rejected. Resetting vote state and requesting revision.',
      state: {
        [voteKey]: null,
        _codex_started_at: null,
        _codex_head_sha: null,
        _pr_url: null,
      },
    };
  }

  const approvalCount = countApprovals(mergedVotes, voteMatch);
  const nextState: Record<string, unknown> = { [voteKey]: mergedVotes };

  // Threshold not yet met → persist the partial vote and ask caller to retry.
  // A retry re-reads persisted hook state, so concurrent final votes that deep-merge
  // to the threshold get a chance to release without another human message.
  if (approvalCount < threshold) {
    return {
      type: 'retryable_block',
      reason: `Waiting for approvals (${approvalCount}/${threshold}). Vote recorded; retry after state merge.`,
      retryAfterMs: 1_000,
      state: nextState,
    };
  }

  // Threshold met → check codex if required
  if (template.requireCodex) {
    const prUrl = findPrUrl(ctx);
    const timeoutMs =
      typeof template.codexTimeoutMs === 'number' ? template.codexTimeoutMs : 600_000;
    const codexStartedAt =
      typeof state._codex_started_at === 'number' ? state._codex_started_at : undefined;
    const storedHeadSha =
      typeof state._codex_head_sha === 'string' ? state._codex_head_sha : undefined;
    const resetPending = state._codex_started_at === null || state._codex_head_sha === null;
    const now = Date.now();

    if (prUrl) {
      const codexResult = await checkCodexApproval(
        prUrl,
        codexStartedAt ?? (storedHeadSha ? undefined : 'head')
      );

      // New revision pushed — reset codex timer so stale approvals don't release
      if (codexResult.headSha && storedHeadSha && storedHeadSha !== codexResult.headSha) {
        return {
          type: 'retryable_block',
          reason: 'New PR revision detected. Resetting codex timer.',
          retryAfterMs: 60_000,
          state: {
            ...nextState,
            _codex_started_at: now,
            _codex_head_sha: codexResult.headSha,
            _pr_url: prUrl,
          },
        };
      }

      if (codexResult.status === 'approved') {
        return {
          type: 'allow',
          message: `Threshold met (${approvalCount}/${threshold}) with codex approval.`,
        };
      }

      // After a reset, storedHeadSha is null. Record the current head and wait
      // for a fresh codex approval instead of accepting historical thumbs-ups.
      if (codexResult.headSha && resetPending && !storedHeadSha) {
        return {
          type: 'retryable_block',
          reason: 'Recording PR head SHA after reset. Waiting for fresh codex approval.',
          retryAfterMs: 60_000,
          state: {
            ...nextState,
            _codex_started_at: codexStartedAt ?? now,
            _codex_head_sha: codexResult.headSha,
            _pr_url: prUrl,
          },
        };
      }

      // Timeout already elapsed — allow regardless of API state
      if (codexStartedAt !== undefined && now - codexStartedAt > timeoutMs) {
        return {
          type: 'allow',
          message: `Threshold met (${approvalCount}/${threshold}). Codex approval timed out after ${timeoutMs}ms; allowing.`,
        };
      }

      // Not yet approved (or API error). Start or continue timeout.
      return {
        type: 'retryable_block',
        reason: 'Threshold met. Waiting for codex[bot] approval.',
        retryAfterMs: 60_000,
        state: {
          ...nextState,
          _codex_started_at: codexStartedAt ?? now,
          _codex_head_sha: codexResult.headSha ?? storedHeadSha,
          _pr_url: prUrl,
        },
      };
    }

    // No PR URL available — rely on timeout only
    if (codexStartedAt !== undefined && now - codexStartedAt > timeoutMs) {
      return {
        type: 'allow',
        message: `Threshold met (${approvalCount}/${threshold}). Codex approval timed out after ${timeoutMs}ms; allowing.`,
      };
    }

    return {
      type: 'retryable_block',
      reason: 'Threshold met. Waiting for codex[bot] approval.',
      retryAfterMs: 60_000,
      state: { ...nextState, _codex_started_at: codexStartedAt ?? now, _pr_url: prUrl },
    };
  }

  return {
    type: 'allow',
    message: `Threshold met (${approvalCount}/${threshold}).`,
  };
}
