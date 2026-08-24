import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SpawnFn } from '../../runtime-spawn/index.ts';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from './script-utils.ts';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from './rate-limit-detector.ts';
import type { ConnectorOutcome } from './connectors/connector.ts';

export const DEFAULT_GH_LOOKUP_TIMEOUT_MS = 30_000;

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

const GITHUB_LOOKUP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_REPO',
  'GH_CONFIG_DIR',
]);

export function buildGitHubLookupEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...BASIC_ENV_KEYS, ...GITHUB_LOOKUP_ENV_KEYS]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

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

export async function fetchRateLimitResetEpoch(
  cwd: string,
  spawnImpl: SpawnFn,
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
    } catch {}
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

export async function runGhJson(
  args: string[],
  cwd: string,
  spawnImpl: SpawnFn,
  options?: {
    timeoutMs?: number;
    hostHint?: string;
    resourceHint?: 'core' | 'graphql';
    stripGHRepo?: boolean;
  }
): Promise<ConnectorOutcome> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GH_LOOKUP_TIMEOUT_MS;

  const ghEnv = buildGitHubLookupEnv();
  if (options?.stripGHRepo) delete ghEnv.GH_REPO;

  let proc;
  try {
    proc = spawnImpl(args, {
      cwd,
      env: ghEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGKILL');
    } catch {}
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
    if (timedOut || isTransientGhError(errorText)) {
      return {
        ok: false,
        error: timedOut ? `gh lookup timed out after ${timeoutMs}ms` : errorText,
        retryable: true,
        retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
      };
    }
    return { ok: false, error: errorText };
  }

  const parsed = parseJsonAny(stdoutResult.text);
  if (parsed === undefined) {
    if (stdoutResult.truncated) {
      return {
        ok: false,
        error: `gh response exceeded the ${MAX_BUFFER_BYTES}-byte buffer and was truncated`,
      };
    }
    return {
      ok: false,
      error: 'gh produced empty or non-JSON stdout',
      retryable: true,
      retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  return { ok: true, data: parsed };
}

function isTransientGhError(errorText: string): boolean {
  return (
    /HTTP\s*5\d\d/i.test(errorText) ||
    /server error/i.test(errorText) ||
    /bad gateway/i.test(errorText) ||
    /service unavailable/i.test(errorText) ||
    /internal server error/i.test(errorText) ||
    /timeout|timed out/i.test(errorText) ||
    /deadline exceeded/i.test(errorText) ||
    /dial tcp/i.test(errorText) ||
    /no such host/i.test(errorText) ||
    /connection refused/i.test(errorText) ||
    /connection reset/i.test(errorText) ||
    /temporary failure/i.test(errorText)
  );
}

function parseJsonAny(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
