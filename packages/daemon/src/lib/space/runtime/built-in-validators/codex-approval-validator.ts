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
import type { SpaceWorkflow } from '@neokai/shared';
import { parseAddress } from '../../../../../../messaging/src/address';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_TIMEOUT_MS = 600_000; // 10 minutes
const CODEX_DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
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
  prUrl?: string;
  terminalOutcome?: 'allow' | 'block';
}

interface GitHubReaction {
  id: number;
  content: string;
  created_at: string;
  user: { login: string };
}

interface GitHubPullRequest {
  head?: {
    sha?: string;
    repo?: {
      name?: string;
      full_name?: string;
      owner?: { login?: string };
    };
  };
}

interface GitHubCommit {
  commit?: {
    committer?: { date?: string };
    author?: { date?: string };
  };
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

function samePrUrl(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const parsedA = parsePrUrl(a);
  const parsedB = parsePrUrl(b);
  return !!(
    parsedA &&
    parsedB &&
    parsedA.host === parsedB.host &&
    parsedA.owner === parsedB.owner &&
    parsedA.repo === parsedB.repo &&
    parsedA.number === parsedB.number
  );
}

function resolvePrUrl(
  currentArtifacts: Array<{
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>,
  params: Record<string, unknown>,
  gateDataJson?: string,
  contextPrUrl?: string
): string | null {
  // Prefer the current handoff's PR URL (params.data) over stale artifacts
  const nestedData = params.data as Record<string, unknown> | undefined;
  if (nestedData) {
    const url =
      (typeof nestedData.prUrl === 'string' && nestedData.prUrl) ||
      (typeof nestedData.pr_url === 'string' && nestedData.pr_url) ||
      '';
    if (url) return url;
  }

  const url =
    (typeof params.prUrl === 'string' && params.prUrl) ||
    (typeof params.pr_url === 'string' && params.pr_url) ||
    '';
  if (url) return url;

  if (contextPrUrl) return contextPrUrl;

  if (gateDataJson) {
    try {
      const gateData = JSON.parse(gateDataJson) as Record<string, unknown>;
      const gateUrl =
        (typeof gateData.prUrl === 'string' && gateData.prUrl) ||
        (typeof gateData.pr_url === 'string' && gateData.pr_url) ||
        '';
      if (gateUrl) return gateUrl;
    } catch {
      // Ignore malformed optional gate data; validator will fall back to artifacts.
    }
  }

  // Fall back to run artifacts
  for (const artifact of currentArtifacts) {
    const data = artifact.data as Record<string, unknown> | undefined;
    if (data) {
      const artUrl =
        (typeof data.prUrl === 'string' && data.prUrl) ||
        (typeof data.pr_url === 'string' && data.pr_url) ||
        '';
      if (artUrl) return artUrl;
    }
  }

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

async function fetchCommitTimestamp(
  pr: ParsedPr,
  prData: GitHubPullRequest,
  headSha: string,
  token: string
): Promise<number | undefined> {
  const apiBase = getApiBase(pr.host);
  const repoFullName = prData.head?.repo?.full_name;
  const repoOwner = prData.head?.repo?.owner?.login ?? repoFullName?.split('/')[0] ?? pr.owner;
  const repoName = prData.head?.repo?.name ?? repoFullName?.split('/')[1] ?? pr.repo;
  const commit = (await fetchGitHubJson(
    `${apiBase}/repos/${repoOwner}/${repoName}/commits/${headSha}`,
    token
  )) as GitHubCommit;

  return parseIsoMs(commit.commit?.committer?.date) ?? parseIsoMs(commit.commit?.author?.date);
}

function toEpochMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function parseIsoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** Truncate to second precision to match GitHub reaction timestamps. */
function toEpochSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

function resolveTokenForHost(host: string): string {
  const isEnterprise = host !== 'github.com';
  if (isEnterprise) {
    return process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN || '';
  }
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
}

function resolveRetryDelayMs(templateData: Record<string, unknown> | undefined): number {
  const configured = templateData?.codexPollIntervalMs;
  return typeof configured === 'number' && configured > 0
    ? configured
    : CODEX_DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Resolve a raw target string to node names, handling @worker: and @role:
 * address formats, node IDs, agent slot names, and bare node names.
 */
function resolveTargetToNodeNames(
  rawTarget: string,
  workflow: SpaceWorkflow | undefined
): string[] {
  if (!workflow) return [rawTarget];

  const trimmed = rawTarget.trim();
  const nodes = workflow.nodes ?? [];

  // Build lookup maps
  const nodeIdToName = new Map<string, string>();
  const slotToNodes = new Map<string, string[]>();
  const nodeNames = new Set<string>();

  for (const node of nodes) {
    if (node.name) {
      nodeNames.add(node.name);
      if (node.id) nodeIdToName.set(node.id, node.name);
    }
    for (const agent of node.agents ?? []) {
      if (agent.name) {
        const existing = slotToNodes.get(agent.name) ?? [];
        existing.push(node.name);
        slotToNodes.set(agent.name, existing);
      }
    }
  }

  // Node ID lookup
  if (nodeIdToName.has(trimmed)) return [nodeIdToName.get(trimmed)!];

  // Exact node name
  if (nodeNames.has(trimmed)) return [trimmed];

  // Agent slot name
  const slotMatches = slotToNodes.get(trimmed);
  if (slotMatches) return [...slotMatches];

  // @worker: address
  if (trimmed.startsWith('@worker:')) {
    try {
      const addr = parseAddress(trimmed);
      if (addr.kind === 'worker') {
        const decoded = decodeURIComponent(addr.nodeId);
        if (nodeIdToName.has(decoded)) return [nodeIdToName.get(decoded)!];
        const decodedSlots = slotToNodes.get(decoded);
        if (decodedSlots) return [...decodedSlots];
        return [decoded];
      }
    } catch {
      // fall through
    }
  }

  // @role: address
  if (trimmed.startsWith('@role:')) {
    const role = trimmed.slice(6);
    const actorRolePrefix = 'actor-role:';
    if (role.startsWith(actorRolePrefix)) {
      const value = decodeURIComponent(role.slice(actorRolePrefix.length));
      if (nodeIdToName.has(value)) return [nodeIdToName.get(value)!];
      const valueSlots = slotToNodes.get(value);
      if (valueSlots) return [...valueSlots];
      return [value];
    }
    if (nodeIdToName.has(role)) return [nodeIdToName.get(role)!];
    const roleSlots = slotToNodes.get(role);
    if (roleSlots) return [...roleSlots];
    return [role];
  }

  return [trimmed];
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const ALLOWED_PR_HOSTS = new Set(['github.com', process.env.GH_HOST].filter(Boolean) as string[]);

export const codexReviewApprovedValidator: BuiltInValidatorFn = async (context) => {
  const {
    workflow,
    lastResult,
    currentArtifacts,
    params,
    permittedExternalLookups,
    methodName,
    templateData,
    workflowStartIso,
    gateDataJson,
    prUrl: contextPrUrl,
  } = context;

  // Load persisted state from previous invocation
  const persisted = (lastResult?.data ?? {}) as CodexPersistedState;
  const retryDelayMs = resolveRetryDelayMs(templateData);

  // For send_message hooks, only enforce when the target matches configured handoff targets.
  // Targets may be node names, agent slot names, or @worker:/@role: addresses.
  if (methodName === 'send_message') {
    const enforceForTargets = templateData?.enforceForTargets as string[] | undefined;
    if (enforceForTargets && enforceForTargets.length > 0) {
      const rawTarget = (params as Record<string, unknown>).target;
      const rawTargets: string[] = Array.isArray(rawTarget) ? rawTarget : [rawTarget];

      // Broadcast '*' fans out to all permitted targets, so treat it as matching
      const isBroadcast = rawTargets.some((t) => typeof t === 'string' && t.trim() === '*');
      if (!isBroadcast) {
        // Resolve each raw target to node names, then check against enforceForTargets
        const matched = rawTargets.some((t) => {
          if (typeof t !== 'string') return false;
          const resolved = resolveTargetToNodeNames(t, workflow);
          return resolved.some((rn) => enforceForTargets.includes(rn));
        });
        if (!matched) {
          return {
            type: 'allow',
            data: Object.keys(persisted).length > 0 ? { ...persisted } : undefined,
          };
        }
      }
    }
  }

  if (!permittedExternalLookups.includes('github')) {
    return {
      type: 'block',
      reason: 'Codex review check requires github external lookup permission',
    };
  }

  const prUrl = resolvePrUrl(currentArtifacts, params ?? {}, gateDataJson, contextPrUrl);
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

  const token = resolveTokenForHost(prInfo.host);
  if (!token) {
    return {
      type: 'block',
      reason: 'GitHub token not available for Codex review check',
    };
  }

  try {
    // Always fetch current PR head SHA — never trust terminal outcomes without
    // verifying the head hasn't changed since the last check.
    const apiBase = getApiBase(prInfo.host);
    const prData = (await fetchGitHubJson(
      `${apiBase}/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.number}`,
      token
    )) as GitHubPullRequest;

    const currentHeadSha = prData.head?.sha;
    if (!currentHeadSha) {
      return {
        type: 'block',
        reason: 'Could not resolve PR head SHA',
        data: { prUrl },
      };
    }

    const hasPriorSha = persisted.currentHeadSha !== undefined;
    const headChanged = hasPriorSha && persisted.currentHeadSha !== currentHeadSha;
    const prChanged = !samePrUrl(persisted.prUrl, prUrl);

    // Re-check terminal outcome after confirming head and PR identity have not changed
    if (persisted.terminalOutcome === 'allow' && !headChanged && !prChanged) {
      return {
        type: 'allow',
        data: {
          ...persisted,
          currentHeadSha,
          prUrl,
          terminalOutcome: 'allow',
        },
      };
    }
    if (persisted.terminalOutcome === 'block' && !headChanged && !prChanged) {
      return {
        type: 'block',
        reason: 'Codex review did not pass',
        data: {
          ...persisted,
          currentHeadSha,
          prUrl,
          terminalOutcome: 'block',
        },
      };
    }

    const now = Date.now();
    const isFirstCheck = persisted.currentHeadSha === undefined;
    const isNewReviewWindow = headChanged || prChanged || isFirstCheck;
    const workflowStartedAt = parseIsoMs(workflowStartIso);
    const firstCheckFreshnessAnchor = workflowStartedAt ?? now;
    let headCommitTimestamp: number | undefined;
    if (isNewReviewWindow) {
      try {
        headCommitTimestamp = await fetchCommitTimestamp(prInfo, prData, currentHeadSha, token);
      } catch {
        headCommitTimestamp = undefined;
      }
    }
    // Truncate to second precision so comparisons with GitHub timestamps
    // (which are second-precision) don't treat same-second reactions as stale.
    const currentHeadBecameHeadAt = toEpochSeconds(
      isNewReviewWindow
        ? isFirstCheck
          ? Math.max(headCommitTimestamp ?? firstCheckFreshnessAnchor, firstCheckFreshnessAnchor)
          : (headCommitTimestamp ?? now)
        : (persisted.currentHeadBecameHeadAt ?? now)
    );
    const checkStartedAt = isNewReviewWindow ? now : (persisted.checkStartedAt ?? now);

    // Fetch all reactions (PRs are issues for reaction API)
    const reactions = await fetchAllReactions(prInfo, token);
    const codexReactions = reactions.filter((r) => CODEX_BOTS.has(r.user?.login));

    // Reactions are PR-level, not commit-level. Even first hook invocation must
    // require reactions posted after workflow start / first observed head time.
    const freshReactions = codexReactions.filter(
      (r) => toEpochMs(r.created_at) >= currentHeadBecameHeadAt
    );

    const freshPlusOnes = freshReactions.filter((r) => r.content === '+1');
    const freshEyes = freshReactions.filter((r) => r.content === 'eyes');

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

    // Fresh +1 → allow, even if it arrived just before a timeout-bound retry.
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

    // Eyes or stale +1 → retryable
    if (freshEyes.length > 0 || stalePlusOnes.length > 0) {
      const reason =
        freshEyes.length > 0
          ? `Codex review in progress (eyes) on PR head ${currentHeadSha}`
          : `Codex +1 is stale (previous head); waiting for fresh +1 on ${currentHeadSha}`;

      return {
        type: 'retryable_block',
        reason,
        retryAfterMs: retryDelayMs,
        data: {
          currentHeadSha,
          currentHeadBecameHeadAt,
          lastReaction: freshEyes.length > 0 ? ('eyes' as const) : ('stale_plus_one' as const),
          lastReactionTimestamp,
          nextRetryAt: now + retryDelayMs,
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
      retryAfterMs: retryDelayMs,
      data: {
        currentHeadSha,
        currentHeadBecameHeadAt,
        lastReaction: 'none' as const,
        lastReactionTimestamp,
        nextRetryAt: now + retryDelayMs,
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
      data: Object.keys(persisted).length > 0 ? { ...persisted, prUrl } : { prUrl },
    };
  }
};
