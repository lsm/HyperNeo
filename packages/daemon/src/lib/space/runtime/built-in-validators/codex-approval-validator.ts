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
import type { WorkflowHookResult } from '@neokai/shared';

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
        return { owner: parts[0], repo: parts[1], number: num };
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

function toEpochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export const codexReviewApprovedValidator: BuiltInValidatorFn = async (context) => {
  const { nodeName, workflow, lastResult, currentArtifacts, params, permittedExternalLookups } =
    context;

  // Only enforce when the workflow node explicitly requests it
  const node = workflow?.nodes?.find((n) => n.name === nodeName);
  if (!node?.requireCodexApproval) {
    return { type: 'allow' };
  }

  // Load persisted state from previous invocation
  const persisted = (lastResult?.data ?? {}) as CodexPersistedState;

  // Terminal shortcut — once decided, stay decided
  if (persisted.terminalOutcome === 'allow') {
    return { type: 'allow' };
  }
  if (persisted.terminalOutcome === 'block') {
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

  try {
    // Resolve current PR head SHA
    const prData = (await fetchGitHubJson(
      `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}`,
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

    const now = Date.now();
    const headChanged = persisted.currentHeadSha !== currentHeadSha;
    const currentHeadBecameHeadAt = headChanged ? now : (persisted.currentHeadBecameHeadAt ?? now);
    const checkStartedAt = persisted.checkStartedAt ?? now;

    // Fetch reactions (PRs are issues for reaction API)
    const reactions = (await fetchGitHubJson(
      `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/issues/${prInfo.number}/reactions?per_page=100`,
      token
    )) as GitHubReaction[];

    const codexReactions = reactions.filter((r) => CODEX_BOTS.has(r.user?.login));

    // Fresh = created at or after the current head became head
    const freshReactions = codexReactions.filter(
      (r) => toEpochMs(r.created_at) >= currentHeadBecameHeadAt
    );

    const freshPlusOnes = freshReactions.filter((r) => r.content === '+1');
    const freshEyes = freshReactions.filter((r) => r.content === 'eyes');

    // Stale = exists but predates current head
    const stalePlusOnes = codexReactions.filter(
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
        lastReaction =
          toEpochMs(latest.created_at) >= currentHeadBecameHeadAt
            ? 'current_plus_one'
            : 'stale_plus_one';
      }
    }

    const elapsedMs = now - checkStartedAt;

    // Timeout check
    if (elapsedMs >= CODEX_TIMEOUT_MS) {
      const result: WorkflowHookResult = {
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
      return result;
    }

    // Fresh +1 → allow
    if (freshPlusOnes.length > 0) {
      const result: WorkflowHookResult = {
        type: 'allow',
        data: {
          currentHeadSha,
          lastReaction: 'current_plus_one' as const,
          lastReactionTimestamp,
          prUrl,
          terminalOutcome: 'allow',
        },
      };
      return result;
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
