/**
 * PR Ready Built-in Validator
 *
 * Typed replacement for the legacy PR_READY_BASH_SCRIPT. Validates that a
 * GitHub PR is open, mergeable, and has no unresolved review threads before
 * allowing a send_message handoff to a review node.
 */

import type { WorkflowHookResult } from '@neokai/shared';
import type { HookExecutorContext } from '../hook-executor';
import { collectWithMaxBuffer, parseJsonStdout } from '../gate-script-executor';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../rate-limit-detector';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1_048_576;

const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
]);
const BASIC_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'AppData',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
]);

interface PrViewResult {
  url: string;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
}

interface ReviewThreadNode {
  id?: string;
  isResolved: boolean;
  comments: { nodes: Array<{ url: string }> };
}

interface ReviewThreadsPage {
  nodes: ReviewThreadNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface GraphQlResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: ReviewThreadsPage;
      };
    };
  };
  errors?: unknown[];
}

export function createPrReadyValidator(
  spawnImpl: typeof Bun.spawn = Bun.spawn
): (context: HookExecutorContext) => Promise<WorkflowHookResult> {
  return async (context: HookExecutorContext): Promise<WorkflowHookResult> => {
    const deadlineMs = Date.now() + DEFAULT_TIMEOUT_MS;
    const prUrlResult = await resolvePrUrl(context, spawnImpl, deadlineMs);
    if (!prUrlResult.success) {
      return commandFailureToHookResult(prUrlResult, 'PR is not ready for Review');
    }
    const prUrl = prUrlResult.prUrl;
    const shouldPatchPrUrl = prUrlResult.shouldPatchPrUrl;

    const prMeta = parsePrUrl(prUrl);
    if (!prMeta) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: unable to parse GitHub PR URL: ${prUrl}`,
      };
    }

    // Run gh pr view. The requested fields (mergeable/mergeStateStatus) are
    // GraphQL PullRequest fields in the GitHub CLI, so a rate-limit probe uses
    // the `graphql` resource window rather than REST `core`.
    const prView = await runCommand<PrViewResult>(
      ['gh', 'pr', 'view', prUrl, '--json', 'url,state,mergeable,mergeStateStatus'],
      context.workspacePath,
      remainingTimeoutMs(deadlineMs),
      spawnImpl,
      { hostHint: prMeta.host, resourceHint: 'graphql' }
    );
    if (!prView.success) {
      return commandFailureToHookResult(prView, 'PR is not ready for Review');
    }

    const prJson = prView.data;
    const prState = prJson.state;
    if (prState !== 'OPEN') {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR state is ${prState ?? 'unknown'} (expected OPEN)`,
      };
    }

    const mergeable = prJson.mergeable;
    if (mergeable === 'UNKNOWN') {
      return {
        type: 'retryable_block',
        reason: 'Waiting for GitHub mergeability/checks',
        retryAfterMs: 30_000,
      };
    }
    if (mergeable !== 'MERGEABLE') {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR is not mergeable (mergeable: ${mergeable ?? 'unknown'})`,
      };
    }

    const mergeStateStatus = prJson.mergeStateStatus;
    if (mergeStateStatus === 'UNKNOWN') {
      return {
        type: 'retryable_block',
        reason: 'Waiting for GitHub mergeability/checks',
        retryAfterMs: 30_000,
      };
    }
    if (
      mergeStateStatus !== 'CLEAN' &&
      mergeStateStatus !== 'HAS_HOOKS' &&
      mergeStateStatus !== 'BLOCKED'
    ) {
      return {
        type: 'block',
        reason: `PR is not ready for Review: PR merge checks not satisfied (mergeStateStatus: ${mergeStateStatus ?? 'unknown'})`,
      };
    }

    // Check unresolved review threads
    const threadsResult = await runReviewThreadsQuery(
      prMeta,
      context.workspacePath,
      spawnImpl,
      deadlineMs
    );
    if (!threadsResult.success) {
      return commandFailureToHookResult(threadsResult, 'PR is not ready for Review');
    }

    const unresolvedUrls = threadsResult.unresolvedUrls;
    if (unresolvedUrls.length > 0) {
      return {
        type: 'block',
        reason:
          `PR is not ready for Review: PR has ${unresolvedUrls.length} unresolved review conversation(s); resolve them before handoff:\n` +
          unresolvedUrls.join('\n'),
      };
    }

    if (shouldPatchPrUrl) {
      return {
        type: 'patch_params',
        patch: { data: { ...extractDataRecord(context), pr_url: prJson.url } },
        data: { pr_url: prJson.url },
      };
    }

    return {
      type: 'allow',
      data: { pr_url: prJson.url },
    };
  };
}

async function resolvePrUrl(
  context: HookExecutorContext,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<
  | { success: true; prUrl: string; shouldPatchPrUrl: boolean }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const boundedPrUrl = extractPrUrlFromParams(context.params);
  if (boundedPrUrl) return { success: true, prUrl: boundedPrUrl, shouldPatchPrUrl: false };

  const rawPrUrl = context.rawParams ? extractPrUrlFromParams(context.rawParams) : undefined;
  if (rawPrUrl) return { success: true, prUrl: rawPrUrl, shouldPatchPrUrl: false };

  const templatePrUrl = extractTemplatePrUrl(context);
  if (templatePrUrl) return { success: true, prUrl: templatePrUrl, shouldPatchPrUrl: true };

  // Run gh pr view for current branch. The URL field is resolved via GitHub
  // CLI's GraphQL PR finder, so a rate-limit probe uses the `graphql` resource
  // window rather than REST `core`.
  const currentBranchPr = await runCommand<{ url?: string }>(
    ['gh', 'pr', 'view', '--json', 'url'],
    context.workspacePath,
    remainingTimeoutMs(deadlineMs),
    spawnImpl,
    { resourceHint: 'graphql' }
  );
  if (!currentBranchPr.success) {
    return {
      success: false,
      error: `no PR URL provided and current-branch PR discovery failed: ${currentBranchPr.error}`,
      rateLimited: currentBranchPr.rateLimited,
      retryAfterMs: currentBranchPr.retryAfterMs,
    };
  }
  if (typeof currentBranchPr.data.url !== 'string' || currentBranchPr.data.url.length === 0) {
    return {
      success: false,
      error: 'no PR URL provided and current-branch PR discovery returned no URL',
    };
  }
  return { success: true, prUrl: currentBranchPr.data.url, shouldPatchPrUrl: true };
}

function extractDataRecord(context: HookExecutorContext): Record<string, unknown> {
  const data = context.rawParams?.data ?? context.params.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? { ...data } : {};
}

function extractTemplatePrUrl(context: HookExecutorContext): string | undefined {
  const templateData = context.templateData;
  if (
    typeof templateData === 'object' &&
    templateData !== null &&
    typeof templateData.pr_url === 'string'
  ) {
    return templateData.pr_url;
  }
  return undefined;
}

function extractPrUrlFromParams(params: Record<string, unknown>): string | undefined {
  const data = params.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as Record<string, unknown>).pr_url === 'string'
  ) {
    return (data as Record<string, unknown>).pr_url as string;
  }
  return undefined;
}

function parsePrUrl(
  url: string
): { host: string; owner: string; repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/([0-9]+)/);
  if (!match) return null;
  return { host: match[1], owner: match[2], repo: match[3], number: match[4] };
}

async function runReviewThreadsQuery(
  meta: { host: string; owner: string; repo: string; number: string },
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<
  | { success: true; unresolvedUrls: string[] }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const unresolvedUrls: string[] = [];
  let cursor: string | null = null;

  while (true) {
    const args: string[] = ['gh', 'api', 'graphql', '--hostname', meta.host];
    if (cursor) {
      args.push(
        '-f',
        `owner=${meta.owner}`,
        '-f',
        `name=${meta.repo}`,
        '-F',
        `number=${meta.number}`,
        '-f',
        `cursor=${cursor}`,
        '-f',
        `query=query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}`
      );
    } else {
      args.push(
        '-f',
        `owner=${meta.owner}`,
        '-f',
        `name=${meta.repo}`,
        '-F',
        `number=${meta.number}`,
        '-f',
        `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}`
      );
    }

    const result = await runCommand<GraphQlResponse>(
      args,
      cwd,
      remainingTimeoutMs(deadlineMs),
      spawnImpl,
      { hostHint: meta.host, resourceHint: 'graphql' }
    );
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        rateLimited: result.rateLimited,
        retryAfterMs: result.retryAfterMs,
      };
    }

    const json = result.data;
    if (json.errors) {
      // GraphQL rate-limit errors come as HTTP 200 with an errors payload.
      // Check if any error message indicates a rate limit and retry accordingly.
      const errorsText = JSON.stringify(json.errors);
      if (isRateLimitError(errorsText)) {
        const resetEpoch = await fetchRateLimitResetEpoch(
          cwd,
          spawnImpl,
          deadlineMs,
          meta.host,
          'graphql'
        );
        return {
          success: false,
          error: `GraphQL rate limit: ${errorsText}`,
          rateLimited: true,
          retryAfterMs: computeRateLimitRetryMs(resetEpoch),
        };
      }
      return { success: false, error: `GraphQL errors: ${errorsText}` };
    }
    const threads = json.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      return { success: false, error: 'Incomplete GraphQL response — reviewThreads data missing' };
    }

    for (const node of threads.nodes) {
      if (!node.isResolved) {
        const url = node.comments.nodes[0]?.url ?? node.id;
        unresolvedUrls.push(url);
      }
    }

    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) {
      return {
        success: false,
        error: 'Incomplete pagination: hasNextPage is true but endCursor is missing',
      };
    }
  }

  return { success: true, unresolvedUrls };
}

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Failure shape returned by `runCommand`.
 *
 * - `rateLimited: true` when stderr matched GitHub rate-limit patterns. The
 *   caller converts this into a `retryable_block` so the workflow engine
 *   backs off rather than re-running the validator on every action dispatch.
 * - `retryAfterMs` is derived from a follow-up `gh api /rate_limit` probe
 *   (when reachable) and bounded by `RATE_LIMIT_MIN_BACKOFF_MS`.
 */
type CommandFailure = {
  success: false;
  error: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
};
type CommandSuccess<T> = { success: true; data: T };
type CommandOutcome<T> = CommandSuccess<T> | CommandFailure;

interface RateLimitPayload {
  resources?: {
    core?: { reset?: number };
    graphql?: { reset?: number };
  };
}

/**
 * Picks the appropriate reset epoch from a `/rate_limit` payload.
 *
 * When `resource` is 'core' or 'graphql', returns that specific window's reset
 * (or null if missing). When undefined, returns the earliest finite reset across
 * both windows as a conservative fallback for cases where the caller doesn't
 * know which resource was exhausted.
 */
function pickRateLimitResetEpoch(
  payload: RateLimitPayload,
  resource?: 'core' | 'graphql'
): number | null {
  if (resource === 'core') {
    const coreReset = payload.resources?.core?.reset;
    return typeof coreReset === 'number' && Number.isFinite(coreReset) ? coreReset : null;
  }
  if (resource === 'graphql') {
    const graphqlReset = payload.resources?.graphql?.reset;
    return typeof graphqlReset === 'number' && Number.isFinite(graphqlReset) ? graphqlReset : null;
  }
  // Fallback: pick the earliest available reset when resource is unknown.
  const resets: number[] = [];
  const coreReset = payload.resources?.core?.reset;
  const graphqlReset = payload.resources?.graphql?.reset;
  if (typeof coreReset === 'number' && Number.isFinite(coreReset)) {
    resets.push(coreReset);
  }
  if (typeof graphqlReset === 'number' && Number.isFinite(graphqlReset)) {
    resets.push(graphqlReset);
  }
  if (resets.length === 0) return null;
  return Math.min(...resets);
}

/**
 * Probes `gh api /rate_limit` to discover the current window's reset epoch.
 *
 * Uses `runCommandRaw` (not `runCommand`) so a persistent rate limit does
 * not cause infinite recursion. When `host` is provided (e.g. a GitHub
 * Enterprise hostname from the rate-limited request), it is forwarded via
 * `--hostname` so the probe queries the same host instead of `github.com`.
 * When `resource` is 'core' or 'graphql', returns that specific window's
 * reset; otherwise returns the earliest available reset as a fallback.
 * Returns null when the probe itself fails — callers fall back to
 * `RATE_LIMIT_MIN_BACKOFF_MS`.
 */
async function fetchRateLimitResetEpoch(
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number,
  host?: string,
  resource?: 'core' | 'graphql'
): Promise<number | null> {
  const args = ['gh', 'api'];
  if (host) args.push('--hostname', host);
  args.push('/rate_limit');
  const result = await runCommandRaw<RateLimitPayload>(
    args,
    cwd,
    Math.min(remainingTimeoutMs(deadlineMs), 5_000),
    spawnImpl
  );
  if (!result.success) return null;
  return pickRateLimitResetEpoch(result.data, resource);
}

/**
 * Spawns a `gh` command, captures stdout/stderr, and parses JSON stdout.
 *
 * This is the inner primitive — it does NOT interpret rate-limit errors.
 * Callers that want rate-limit awareness should use `runCommand` instead.
 */
async function runCommandRaw<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn
): Promise<CommandOutcome<T>> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
    proc.exited,
  ]);

  clearTimeout(killTimer);

  if (exitCode !== 0) {
    return { success: false, error: stderrResult.text.trim() || `gh exited with code ${exitCode}` };
  }

  const parsed = parseJsonStdout(stdoutResult.text);
  if (!parsed) {
    return { success: false, error: 'gh produced empty or non-JSON stdout' };
  }

  return { success: true, data: parsed as T };
}

/**
 * Runs a `gh` command, classifying non-zero exits as rate-limited when the
 * stderr matches GitHub's rate-limit error patterns.
 *
 * On rate-limit detection, performs a follow-up `gh api /rate_limit` probe
 * to compute `retryAfterMs` (bounded by `RATE_LIMIT_MIN_BACKOFF_MS`).
 * `options.hostHint` is forwarded to the probe so an Enterprise rate-limit
 * is measured against the right host. All other failures pass through
 * unchanged so existing block-path behavior is preserved.
 */
async function runCommand<T>(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn,
  options?: { hostHint?: string; resourceHint?: 'core' | 'graphql' }
): Promise<CommandOutcome<T>> {
  const outcome = await runCommandRaw<T>(args, cwd, timeoutMs, spawnImpl);
  if (outcome.success) return outcome;
  if (!isRateLimitError(outcome.error)) return outcome;
  // Secondary rate limits don't update /rate_limit — skip the probe and use minimum backoff.
  if (isSecondaryRateLimitError(outcome.error)) {
    return {
      success: false,
      error: outcome.error,
      rateLimited: true,
      retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  const resetEpoch = await fetchRateLimitResetEpoch(
    cwd,
    spawnImpl,
    Date.now() + timeoutMs,
    options?.hostHint,
    options?.resourceHint
  );
  return {
    success: false,
    error: outcome.error,
    rateLimited: true,
    retryAfterMs: computeRateLimitRetryMs(resetEpoch),
  };
}

/**
 * Wraps a failed `runCommand` outcome into the right `WorkflowHookResult`.
 *
 * Rate-limited failures become `retryable_block` so the workflow engine
 * defers the next attempt past the reset window. All other failures pass
 * through as `block` with the original `prefix` framing.
 */
function commandFailureToHookResult(failure: CommandFailure, prefix: string): WorkflowHookResult {
  if (failure.rateLimited) {
    return {
      type: 'retryable_block',
      reason: `${prefix}: GitHub rate limited — ${failure.error}`,
      retryAfterMs: failure.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  return { type: 'block', reason: `${prefix}: ${failure.error}` };
}
