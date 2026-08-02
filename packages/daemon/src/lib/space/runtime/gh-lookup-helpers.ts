/**
 * Shared `gh` CLI lookup helpers — L2 connector infrastructure (epic #2299, P1 #2301).
 *
 * The single source of truth for spawning `gh`, classifying rate-limit failures,
 * and building the credential env. Both the production `pr_ready` built-in
 * validator (`built-in-validators/pr-ready-validator.ts`) and the github
 * connector (`connectors/github-connector.ts`) import from here so the gh access
 * logic is not duplicated.
 *
 * This is the module the spike (#2300) deferred: it folds the spike-local
 * `connectors/gh-client.ts` together with the env/rate-limit helpers that lived
 * inline in `pr-ready-validator.ts` and `hook-executor.ts`.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from './gate-script-executor';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from './rate-limit-detector';
import type { ConnectorOutcome } from './connectors/connector';

/** Default per-command timeout for a `gh` lookup. */
export const DEFAULT_GH_LOOKUP_TIMEOUT_MS = 30_000;

/** process.env keys forwarded to every `gh` subprocess (credential + base shell). */
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

/**
 * GitHub credential/config keys forwarded to a `gh` subprocess. This is the
 * connector-side superset; the sandboxed SCRIPT-hook env (see the github
 * connector's `auth.envKeys`) declares a narrower surface.
 */
const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
]);

/** Build the env for a trusted `gh` subprocess (the connector's own lookups). */
export function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Resolve the `gh` config directory (where `gh` stores auth). Used both by the
 * github connector (to populate `GH_CONFIG_DIR` in a sandboxed hook env) and by
 * the legacy env-injection fallback. Returns undefined when no config dir is
 * found.
 */
export function resolveGithubConfigDir(): string | undefined {
  const explicit = process.env.GH_CONFIG_DIR;
  if (explicit && existsSync(explicit)) return explicit;

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    const xdgGhConfig = join(xdgConfigHome, 'gh');
    if (existsSync(xdgGhConfig)) return xdgGhConfig;
  }

  const defaultGhConfig = join(homedir(), '.config', 'gh');
  if (existsSync(defaultGhConfig)) return defaultGhConfig;

  return undefined;
}

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
 * both windows as a conservative fallback for callers that don't know which
 * resource was exhausted.
 */
export function pickRateLimitResetEpoch(
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
 * Probe `gh api /rate_limit` for the current window's reset epoch. Spawns its own
 * `gh` process (does not reuse `runGhJson`) so a persistent rate limit does not
 * recurse into another rate-limit classification. When `host` is provided (e.g. a
 * GitHub Enterprise hostname), it is forwarded via `--hostname` so the probe
 * queries the same host. Returns null when the probe itself fails so the caller
 * falls back to `RATE_LIMIT_MIN_BACKOFF_MS` via `computeRateLimitRetryMs`.
 */
export async function fetchRateLimitResetEpoch(
  cwd: string,
  spawnImpl: typeof Bun.spawn,
  timeoutMs: number,
  host?: string,
  resource?: 'core' | 'graphql'
): Promise<number | null> {
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

/**
 * Spawn a `gh` command, capture stdout/stderr, and classify the outcome.
 *
 * - exit 0 + parseable JSON stdout → `{ ok: true, data }`. Accepts any JSON
 *   value (objects AND arrays — the reactions endpoint returns an array).
 * - non-zero exit matching GitHub rate-limit patterns → `{ ok: false,
 *   retryable: true, retryAfterMs }` (secondary throttles use the minimum
 *   backoff; primary limits probe `/rate_limit` for the reset epoch, bounded by
 *   `RATE_LIMIT_MIN_BACKOFF_MS`).
 * - any other failure → `{ ok: false, error }`.
 *
 * `resourceHint` ('core' | 'graphql') routes the reset probe to the right
 * window; `hostHint` forwards an Enterprise hostname to the probe.
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
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GH_LOOKUP_TIMEOUT_MS;

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
