/**
 * Shared GitHub-lookup helpers for built-in hook validators.
 *
 * Both the pre-review `pr_ready` validator and the post-approval `pr_merged`
 * validator shell out to `gh` to inspect PR state and must classify GitHub
 * rate-limit errors as retryable. These primitives — `gh` execution with
 * rate-limit detection, a `/rate_limit` reset probe, a restricted GitHub-only
 * env builder, and a current-branch PR-URL fallback — are extracted here so the
 * two validators share one implementation instead of drifting.
 */

import { collectWithMaxBuffer, parseJsonStdout } from '../gate-script-executor';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../rate-limit-detector';
import type { HookExecutorContext } from '../hook-executor';
import type { WorkflowHookResult } from '@hyperneo/shared';

export const MAX_BUFFER_BYTES = 1_048_576;

export const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
]);

export const BASIC_ENV_KEYS = new Set([
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

/**
 * Failure shape returned by `runCommand`.
 *
 * - `rateLimited: true` when stderr matched GitHub rate-limit patterns. The
 *   caller converts this into a `retryable_block` so the workflow engine backs
 *   off rather than re-running the validator on every action dispatch.
 * - `retryAfterMs` is derived from a follow-up `gh api /rate_limit` probe
 *   (when reachable) and bounded by `RATE_LIMIT_MIN_BACKOFF_MS`.
 */
export type CommandFailure = {
  success: false;
  error: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
};
export type CommandSuccess<T> = { success: true; data: T };
export type CommandOutcome<T> = CommandSuccess<T> | CommandFailure;

export interface RateLimitPayload {
  resources?: {
    core?: { reset?: number };
    graphql?: { reset?: number };
  };
}

export function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

export function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function parseGitRemoteHost(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.hostname || undefined;
  } catch {
    // scp-like SSH remote: git@github.example.com:owner/repo.git
    const match = trimmed.match(/^[^@]+@([^:]+):/);
    return match?.[1];
  }
}

export async function inferGitHubHost(
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<string | undefined> {
  if (process.env.GH_HOST) return process.env.GH_HOST;
  if (process.env.GH_REPO) {
    const parts = process.env.GH_REPO.split('/');
    if (parts.length >= 3 && parts[0]) return parts[0];
  }
  const originUrl = await runTextCommand(
    ['git', 'config', '--get', 'remote.origin.url'],
    cwd,
    Math.min(remainingTimeoutMs(deadlineMs), 2_000),
    spawnImpl
  );
  if (!originUrl) return undefined;
  return parseGitRemoteHost(originUrl);
}

export async function runTextCommand(
  args: string[],
  cwd: string,
  timeoutMs: number,
  spawnImpl: typeof Bun.spawn
): Promise<string | undefined> {
  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return undefined;
  }

  const killTimer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, timeoutMs);

  const [stdoutResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    proc.exited,
  ]);
  clearTimeout(killTimer);
  if (exitCode !== 0) return undefined;
  return stdoutResult.text.trim() || undefined;
}

/**
 * Picks the appropriate reset epoch from a `/rate_limit` payload.
 *
 * When `resource` is 'core' or 'graphql', returns that specific window's reset
 * (or null if missing). When undefined, returns the earliest finite reset across
 * both windows as a conservative fallback for cases where the caller doesn't
 * know which resource was exhausted.
 */
export function pickRateLimitResetEpoch(
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
 * Uses `runCommandRaw` (not `runCommand`) so a persistent rate limit does not
 * cause infinite recursion. When `host` is provided (e.g. a GitHub Enterprise
 * hostname from the rate-limited request), it is forwarded via `--hostname` so
 * the probe queries the same host instead of `github.com`.
 */
export async function fetchRateLimitResetEpoch(
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
export async function runCommandRaw<T>(
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
 * On rate-limit detection, performs a follow-up `gh api /rate_limit` probe to
 * compute `retryAfterMs` (bounded by `RATE_LIMIT_MIN_BACKOFF_MS`).
 * `options.hostHint` is forwarded to the probe so an Enterprise rate-limit is
 * measured against the right host. All other failures pass through unchanged.
 */
export async function runCommand<T>(
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
 * Rate-limited failures become `retryable_block` so the workflow engine defers
 * the next attempt past the reset window. All other failures pass through as
 * `block` with the original `prefix` framing.
 */
export function commandFailureToHookResult(
  failure: CommandFailure,
  prefix: string
): WorkflowHookResult {
  if (failure.rateLimited) {
    return {
      type: 'retryable_block',
      reason: `${prefix}: GitHub rate limited — ${failure.error}`,
      retryAfterMs: failure.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  return { type: 'block', reason: `${prefix}: ${failure.error}` };
}

/** Extracts a `pr_url` string from a params/rawParams `data` record. */
export function extractPrUrlFromParams(params: Record<string, unknown>): string | undefined {
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

/** Extracts a `pr_url` string from a hook definition's bounded `templateData`. */
export function extractTemplatePrUrl(context: HookExecutorContext): string | undefined {
  const templateData = context.templateData;
  if (
    typeof templateData === 'object' &&
    templateData !== null &&
    typeof templateData.pr_url === 'string'
  ) {
    return templateData.pr_url as string;
  }
  return undefined;
}

/**
 * Extracts the most recent PR URL from the run's artifacts.
 *
 * `currentArtifacts` is sorted most-recent-first by the hook engine, so the
 * first hit wins. Mirrors the artifact scan in
 * `SpaceRuntimeService.dispatchPostApproval`, accepting both camelCase `prUrl`
 * and snake_case `pr_url`.
 */
export function extractPrUrlFromArtifacts(
  artifacts: HookExecutorContext['currentArtifacts']
): string | undefined {
  for (const artifact of artifacts) {
    const data = artifact.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    const candidate =
      (typeof record.prUrl === 'string' && record.prUrl) ||
      (typeof record.pr_url === 'string' && record.pr_url);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Resolves the PR URL for the current branch via `gh pr view --json url`.
 *
 * Shared last-resort fallback used by validators that have no explicit PR URL
 * in their params. The `graphql` resource window backs the CLI's PR finder.
 */
export async function resolveCurrentBranchPrUrl(
  context: HookExecutorContext,
  spawnImpl: typeof Bun.spawn,
  deadlineMs: number
): Promise<
  | { success: true; prUrl: string }
  | ({ success: false; error: string } & Pick<CommandFailure, 'rateLimited' | 'retryAfterMs'>)
> {
  const currentBranchPr = await runCommand<{ url?: string }>(
    ['gh', 'pr', 'view', '--json', 'url'],
    context.workspacePath,
    remainingTimeoutMs(deadlineMs),
    spawnImpl,
    {
      resourceHint: 'graphql',
      hostHint: await inferGitHubHost(context.workspacePath, spawnImpl, deadlineMs),
    }
  );
  if (!currentBranchPr.success) {
    return {
      success: false,
      error: `current-branch PR discovery failed: ${currentBranchPr.error}`,
      rateLimited: currentBranchPr.rateLimited,
      retryAfterMs: currentBranchPr.retryAfterMs,
    };
  }
  if (typeof currentBranchPr.data.url !== 'string' || currentBranchPr.data.url.length === 0) {
    return { success: false, error: 'current-branch PR discovery returned no URL' };
  }
  return { success: true, prUrl: currentBranchPr.data.url };
}
