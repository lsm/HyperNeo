/**
 * gh-client — minimal `gh` CLI spawn client (THROWAWAY spike helper, #2300).
 *
 * This is the "lookup helpers" the github connector wraps. It centralises the
 * spawn + JSON-parse + rate-limit classification logic that today lives inline
 * in `built-in-validators/pr-ready-validator.ts`, so the connector ops can
 * share one implementation. It reuses the SAME building blocks the production
 * validator uses (`collectWithMaxBuffer`, `parseJsonStdout`, the rate-limit
 * detectors) — demonstrating the connector wraps the existing github logic
 * rather than reinventing it.
 *
 * P1 (#2301) will extract this into a shared `gh-lookup-helpers.ts` that both
 * the production validator and the connector import; for this throwaway spike
 * the small env sets are duplicated to avoid touching production code.
 */

import { collectWithMaxBuffer } from '../gate-script-executor';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../rate-limit-detector';
import type { ConnectorOutcome } from './connector';

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

function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface RateLimitPayload {
  resources?: {
    core?: { reset?: number };
    graphql?: { reset?: number };
  };
}

function pickRateLimitResetEpoch(
  payload: RateLimitPayload,
  resource?: 'core' | 'graphql'
): number | null {
  if (resource === 'core') {
    const reset = payload.resources?.core?.reset;
    return typeof reset === 'number' && Number.isFinite(reset) ? reset : null;
  }
  if (resource === 'graphql') {
    const reset = payload.resources?.graphql?.reset;
    return typeof reset === 'number' && Number.isFinite(reset) ? reset : null;
  }
  const resets: number[] = [];
  const coreReset = payload.resources?.core?.reset;
  const graphqlReset = payload.resources?.graphql?.reset;
  if (typeof coreReset === 'number' && Number.isFinite(coreReset)) resets.push(coreReset);
  if (typeof graphqlReset === 'number' && Number.isFinite(graphqlReset)) resets.push(graphqlReset);
  return resets.length === 0 ? null : Math.min(...resets);
}

/**
 * Spawn a `gh` command, capture stdout/stderr, and classify the outcome.
 *
 * - exit 0 + parseable JSON stdout → `{ ok: true, data }`.
 * - non-zero exit matching GitHub rate-limit patterns → `{ ok: false,
 *   retryable: true, retryAfterMs }` (secondary throttles use the minimum
 *   backoff; primary limits probe `/rate_limit` for the reset epoch, bounded
 *   by `RATE_LIMIT_MIN_BACKOFF_MS`).
 * - any other failure → `{ ok: false, error }`.
 *
 * `resourceHint` ('core' | 'graphql') routes the reset probe to the right
 * window, matching the production validator.
 */
export async function runGhJson(
  args: string[],
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  options?: {
    timeoutMs?: number;
    hostHint?: string;
    resourceHint?: 'core' | 'graphql';
  }
): Promise<ConnectorOutcome> {
  const timeoutMs = options?.timeoutMs ?? 30_000;

  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
    const stderrText = stderrResult.text.trim();
    const errorText = stderrText || `gh exited with code ${exitCode}`;
    if (isRateLimitError(errorText)) {
      if (isSecondaryRateLimitError(errorText)) {
        return {
          ok: false,
          error: errorText,
          retryable: true,
          retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
        };
      }
      const resetEpoch = await fetchRateLimitResetEpoch(
        args,
        cwd,
        spawnImpl,
        Math.min(timeoutMs, 5_000),
        options?.hostHint,
        options?.resourceHint
      );
      return {
        ok: false,
        error: errorText,
        retryable: true,
        retryAfterMs: computeRateLimitRetryMs(resetEpoch),
      };
    }
    return { ok: false, error: errorText };
  }

  // NOTE: unlike `parseJsonStdout` (which rejects arrays), this accepts any
  // JSON value — the reactions endpoint returns an array, which `getReactions`
  // then normalises/wraps. Object responses (`gh pr view --json`, graphql) pass
  // through unchanged.
  const parsed = parseJsonAny(stdoutResult.text);
  if (parsed === undefined) {
    return { ok: false, error: 'gh produced empty or non-JSON stdout' };
  }
  return { ok: true, data: parsed };
}

/** Parse stdout as JSON, accepting objects AND arrays. Returns undefined when
 *  the output is empty or unparseable. */
function parseJsonAny(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Probe `gh api /rate_limit` for the current window's reset epoch. Mirrors the
 * production validator; returns null when the probe itself fails so the caller
 * falls back to `RATE_LIMIT_MIN_BACKOFF_MS` via `computeRateLimitRetryMs`.
 *
 * Spawns its own `gh` process (does not reuse `runGhJson`) so a persistent
 * rate limit does not recurse into another rate-limit classification.
 */
async function fetchRateLimitResetEpoch(
  callerArgs: string[],
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  timeoutMs: number,
  hostHint?: string,
  resource?: 'core' | 'graphql'
): Promise<number | null> {
  // Infer the host the rate-limited request targeted, if any (`--hostname`).
  let host = hostHint;
  if (!host) {
    const idx = callerArgs.indexOf('--hostname');
    if (idx >= 0 && idx + 1 < callerArgs.length) host = callerArgs[idx + 1];
  }
  const args = ['gh', 'api'];
  if (host) args.push('--hostname', host);
  args.push('/rate_limit');

  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: buildGitHubLookupEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null;
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
  if (exitCode !== 0) return null;

  const parsed = parseJsonAny(stdoutResult.text) as RateLimitPayload | null;
  if (!parsed) return null;
  return pickRateLimitResetEpoch(parsed, resource);
}
