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
  const data = ctx.params.data as Record<string, unknown> | undefined;
  if (typeof data?.pr_url === 'string') return data.pr_url;
  if (typeof ctx.hookLocalState._pr_url === 'string') return ctx.hookLocalState._pr_url as string;

  for (const artifact of ctx.currentArtifacts) {
    const artifactData = artifact.data as Record<string, unknown> | undefined;
    if (typeof artifactData?.pr_url === 'string') return artifactData.pr_url;
  }

  return undefined;
}

function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Check GitHub for a codex[bot] +1 reaction on the PR body, issue comments,
 * or review comments. Uses the GraphQL API to query all reaction locations
 * in a single request.
 *
 * Returns 'approved' if found, 'waiting' if not, 'error' on failure.
 */
async function checkCodexApproval(prUrl: string): Promise<'approved' | 'waiting' | 'error'> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) return 'error';

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return 'error';

  const query = `
    query($owner:String!,$name:String!,$number:Int!) {
      repository(owner:$owner,name:$name) {
        pullRequest(number:$number) {
          reactions(first:10) {
            nodes { content user { login } }
          }
          comments(first:100) {
            nodes {
              reactions(first:10) {
                nodes { content user { login } }
              }
            }
          }
          reviewThreads(first:100) {
            nodes {
              comments(first:100) {
                nodes {
                  reactions(first:10) {
                    nodes { content user { login } }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { owner: parsed.owner, name: parsed.repo, number: parsed.number },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return 'error';

    const json = (await res.json()) as {
      data?: {
        repository?: {
          pullRequest?: {
            reactions?: {
              nodes?: Array<{ content?: string; user?: { login?: string } }>;
            };
            comments?: {
              nodes?: Array<{
                reactions?: {
                  nodes?: Array<{ content?: string; user?: { login?: string } }>;
                };
              }>;
            };
            reviewThreads?: {
              nodes?: Array<{
                comments?: {
                  nodes?: Array<{
                    reactions?: {
                      nodes?: Array<{ content?: string; user?: { login?: string } }>;
                    };
                  }>;
                };
              }>;
            };
          };
        };
      };
      errors?: unknown[];
    };

    if (json.errors) return 'error';

    const pr = json.data?.repository?.pullRequest;
    if (!pr) return 'error';

    const isCodexPlusOne = (r: { content?: string; user?: { login?: string } }): boolean =>
      (r.user?.login === 'codex[bot]' || r.user?.login === 'chatgpt-codex-connector[bot]') &&
      r.content === 'THUMBS_UP';

    // PR body reactions
    if (pr.reactions?.nodes?.some(isCodexPlusOne)) return 'approved';

    // Issue comments
    for (const comment of pr.comments?.nodes ?? []) {
      if (comment.reactions?.nodes?.some(isCodexPlusOne)) return 'approved';
    }

    // Review comments
    for (const thread of pr.reviewThreads?.nodes ?? []) {
      for (const comment of thread.comments?.nodes ?? []) {
        if (comment.reactions?.nodes?.some(isCodexPlusOne)) return 'approved';
      }
    }

    return 'waiting';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timeout);
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
      state: { [voteKey]: null },
    };
  }

  const approvalCount = countApprovals(mergedVotes, voteMatch);
  const nextState: Record<string, unknown> = { [voteKey]: mergedVotes };

  // Threshold not yet met → block and persist the partial vote
  if (approvalCount < threshold) {
    return {
      type: 'block',
      reason: `Waiting for approvals (${approvalCount}/${threshold}). Vote recorded.`,
      state: nextState,
    };
  }

  // Threshold met → check codex if required
  if (template.requireCodex) {
    const prUrl = findPrUrl(ctx);
    const timeoutMs =
      typeof template.codexTimeoutMs === 'number' ? template.codexTimeoutMs : 600_000;
    const codexStartedAt = state._codex_started_at as number | undefined;
    const now = Date.now();

    // Timeout already elapsed — allow regardless of API state
    if (codexStartedAt !== undefined && now - codexStartedAt > timeoutMs) {
      return {
        type: 'allow',
        message: `Threshold met (${approvalCount}/${threshold}). Codex approval timed out after ${timeoutMs}ms; allowing.`,
      };
    }

    if (prUrl) {
      const codexResult = await checkCodexApproval(prUrl);
      if (codexResult === 'approved') {
        return {
          type: 'allow',
          message: `Threshold met (${approvalCount}/${threshold}) with codex approval.`,
        };
      }
    }

    // Not yet approved (or API error / no prUrl). Start or continue timeout.
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
