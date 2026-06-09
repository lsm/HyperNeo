/**
 * Codex Approval Validator
 *
 * Built-in hook validator that checks `codex[bot]` or
 * `chatgpt-codex-connector[bot]` reactions on a PR before allowing
 * `submit_for_approval` or `approve_task`.
 *
 * State is persisted across invocations via `lastResult.data` so that
 * subsequent retries know the previously-checked head SHA, when it became
 * head, and the terminal outcome.
 *
 * Result semantics:
 *   - `allow`      — fresh `+1` on current head
 *   - `block`      — timeout exceeded, missing PR, or terminal failure
 *   - `retryable_block` — `eyes` present, stale `+1`, or no reaction yet
 */

import type { BuiltInValidatorFn } from '../hook-executor';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_TIMEOUT_MS = 600_000; // 10 minutes
const CODEX_RETRY_DELAY_MS = 60_000; // 1 minute
const CODEX_BOTS = new Set(['codex[bot]', 'chatgpt-codex-connector[bot]']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CodexReactionState = 'none' | 'eyes' | 'stale_plus_one' | 'current_plus_one';

interface CodexPersistedState {
  currentHeadSha?: string;
  currentHeadBecameHeadAt?: number;
  lastReaction?: CodexReactionState;
  lastReactionTimestamp?: number;
  checkStartedAt?: number;
  terminalOutcome?: 'allow' | 'block';
}

interface GitHubReaction {
  id: number;
  content: string;
  created_at: string;
  user: { login: string };
}

interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
  host: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePrUrl(url: string): ParsedPr | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 4 && parts[2] === 'pull') {
      const num = parseInt(parts[3], 10);
      if (!Number.isNaN(num)) {
        return { owner: parts[0], repo: parts[1], number: num, host: u.host };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function resolvePrUrl(
  currentArtifacts: Array<{
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>,
  params: Record<string, unknown>
): string | null {
  for (const artifact of currentArtifacts) {
    const data = artifact.data as Record<string, unknown> | undefined;
    if (data) {
      const url =
        (typeof data.prUrl === 'string' && data.prUrl) ||
        (typeof data.pr_url === 'string' && data.pr_url) ||
        '';
      if (url) return url;
    }
  }

  const url =
    (typeof params.prUrl === 'string' && params.prUrl) ||
    (typeof params.pr_url === 'string' && params.pr_url) ||
    '';
  if (url) return url;

  return null;
}

async function fetchGitHubJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

function getApiBase(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

async function fetchAllReactions(pr: ParsedPr, token: string): Promise<GitHubReaction[]> {
  const apiBase = getApiBase(pr.host);
  const results: GitHubReaction[] = [];
  let page = 1;
  while (true) {
    const data = (await fetchGitHubJson(
      `${apiBase}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/reactions?per_page=100&page=${page}`,
      token
    )) as GitHubReaction[];
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

function toEpochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const ALLOWED_PR_HOSTS = new Set(['github.com', process.env.GH_HOST].filter(Boolean) as string[]);

export const codexReviewApprovedValidator: BuiltInValidatorFn = async (context) => {
  const {
    nodeName,
    workflow,
    lastResult,
    currentArtifacts,
    params,
    permittedExternalLookups,
    methodName,
    templateData,
  } = context;

  // Only enforce when the workflow node explicitly requests it
  const node = workflow?.nodes?.find((n) => n.name === nodeName);
  if (!node?.requireCodexApproval) {
    return { type: 'allow' };
  }

  // For send_message hooks, only enforce when the target matches configured handoff targets
  if (methodName === 'send_message') {
    const enforceForTargets = templateData?.enforceForTargets as string[] | undefined;
    if (enforceForTargets && enforceForTargets.length > 0) {
      const target = (params as Record<string, unknown>).target;
      const targets = Array.isArray(target) ? target : [target];
      if (!targets.some((t) => typeof t === 'string' && enforceForTargets.includes(t))) {
        return { type: 'allow' };
      }
    }
  }

  // Load persisted state from previous invocation
  const persisted = (lastResult?.data ?? {}) as CodexPersistedState;

  // Fast terminal shortcut — if we have a prior SHA and no evidence of change,
  // skip the network call entirely. If head might have changed, we still need
  // to fetch to verify.
  const hasPriorSha = persisted.currentHeadSha !== undefined;
  if (persisted.terminalOutcome === 'allow' && hasPriorSha) {
    return { type: 'allow' };
  }
  if (persisted.terminalOutcome === 'block' && hasPriorSha) {
    return {
      type: 'block',
      reason: 'Codex review did not pass',
      data: { currentHeadSha: persisted.currentHeadSha },
    };
  }

  if (!permittedExternalLookups.includes('github')) {
    return {
      type: 'block',
      reason: 'Codex review check requires github external lookup permission',
    };
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) {
    return {
      type: 'block',
      reason: 'GitHub token not available for Codex review check',
    };
  }

  const prUrl = resolvePrUrl(currentArtifacts, params ?? {});
  if (!prUrl) {
    return {
      type: 'block',
      reason: 'No PR URL available for Codex review check. Save an artifact with pr_url.',
    };
  }

  const prInfo = parsePrUrl(prUrl);
  if (!prInfo) {
    return {
      type: 'block',
      reason: `Invalid PR URL for Codex review check: ${prUrl}`,
    };
  }

  if (!ALLOWED_PR_HOSTS.has(prInfo.host)) {
    return {
      type: 'block',
      reason: `PR host "${prInfo.host}" is not in the allowed list. Only ${[...ALLOWED_PR_HOSTS].join(', ')} are permitted.`,
    };
  }

  try {
    // Resolve current PR head SHA
    const apiBase = getApiBase(prInfo.host);
    const prData = (await fetchGitHubJson(
      `${apiBase}/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}`,
      token
    )) as { head?: { sha?: string } };

    const currentHeadSha = prData.head?.sha;
    if (!currentHeadSha) {
      return {
        type: 'block',
        reason: 'Could not resolve PR head SHA',
        data: { prUrl },
      };
    }

    const headChanged = hasPriorSha && persisted.currentHeadSha !== currentHeadSha;

    // Re-check terminal outcome after confirming head has not changed
    if (persisted.terminalOutcome === 'allow' && !headChanged) {
      return { type: 'allow' };
    }
    if (persisted.terminalOutcome === 'block' && !headChanged) {
      return {
        type: 'block',
        reason: 'Codex review did not pass',
        data: { currentHeadSha: persisted.currentHeadSha },
      };
    }

    const now = Date.now();
    const isFirstCheck = persisted.currentHeadSha === undefined;
    const currentHeadBecameHeadAt = headChanged ? now : (persisted.currentHeadBecameHeadAt ?? now);
    const checkStartedAt = persisted.checkStartedAt ?? now;

    // Fetch all reactions (PRs are issues for reaction API)
    const reactions = await fetchAllReactions(prInfo, token);
    const codexReactions = reactions.filter((r) => CODEX_BOTS.has(r.user?.login));

    // On first check, accept any reaction on the current head as fresh.
    // On subsequent checks, only reactions posted after we first observed this head count.
    const freshReactions = isFirstCheck
      ? codexReactions
      : codexReactions.filter((r) => toEpochMs(r.created_at) >= currentHeadBecameHeadAt);

    const freshPlusOnes = freshReactions.filter((r) => r.content === '+1');
    const freshEyes = freshReactions.filter((r) => r.content === 'eyes');

    const stalePlusOnes = isFirstCheck
      ? []
      : codexReactions.filter(
          (r) => r.content === '+1' && toEpochMs(r.created_at) < currentHeadBecameHeadAt
        );

    // Determine the latest observed reaction (fresh or stale) for UX state
    const allSorted = [...codexReactions].sort(
      (a, b) => toEpochMs(b.created_at) - toEpochMs(a.created_at)
    );

    let lastReaction: CodexReactionState = 'none';
    let lastReactionTimestamp: number | undefined;

    if (allSorted.length > 0) {
      const latest = allSorted[0];
      lastReactionTimestamp = toEpochMs(latest.created_at);
      if (latest.content === 'eyes') {
        lastReaction = 'eyes';
      } else if (latest.content === '+1') {
        lastReaction = isFirstCheck
          ? 'current_plus_one'
          : toEpochMs(latest.created_at) >= currentHeadBecameHeadAt
            ? 'current_plus_one'
            : 'stale_plus_one';
      }
    }

    const elapsedMs = now - checkStartedAt;

    // Timeout check
    if (elapsedMs >= CODEX_TIMEOUT_MS) {
      return {
        type: 'block',
        reason: `Codex review did not pass: timeout after ${Math.round(elapsedMs / 1000)}s on head ${currentHeadSha}`,
        data: {
          currentHeadSha,
          lastReaction,
          elapsedMs,
          prUrl,
          terminalOutcome: 'block',
        },
      };
    }

    // Fresh +1 → allow
    if (freshPlusOnes.length > 0) {
      return {
        type: 'allow',
        data: {
          currentHeadSha,
          lastReaction: 'current_plus_one' as const,
          lastReactionTimestamp,
          prUrl,
          terminalOutcome: 'allow',
        },
      };
    }

    // Eyes or stale +1 → retryable
    if (freshEyes.length > 0 || stalePlusOnes.length > 0) {
      const reason =
        freshEyes.length > 0
          ? `Codex review in progress (eyes) on PR head ${currentHeadSha}`
          : `Codex +1 is stale (previous head); waiting for fresh +1 on ${currentHeadSha}`;

      return {
        type: 'retryable_block',
        reason,
        retryAfterMs: CODEX_RETRY_DELAY_MS,
        data: {
          currentHeadSha,
          currentHeadBecameHeadAt,
          lastReaction: freshEyes.length > 0 ? ('eyes' as const) : ('stale_plus_one' as const),
          lastReactionTimestamp,
          nextRetryAt: now + CODEX_RETRY_DELAY_MS,
          elapsedMs,
          timeoutMs: CODEX_TIMEOUT_MS,
          prUrl,
          checkStartedAt,
        },
      };
    }

    // No reactions yet → retryable
    return {
      type: 'retryable_block',
      reason: `Waiting for Codex review on latest PR head ${currentHeadSha}`,
      retryAfterMs: CODEX_RETRY_DELAY_MS,
      data: {
        currentHeadSha,
        currentHeadBecameHeadAt,
        lastReaction: 'none' as const,
        lastReactionTimestamp,
        nextRetryAt: now + CODEX_RETRY_DELAY_MS,
        elapsedMs,
        timeoutMs: CODEX_TIMEOUT_MS,
        prUrl,
        checkStartedAt,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: 'block',
      reason: `Codex review check failed: ${message}`,
    };
  }
};
