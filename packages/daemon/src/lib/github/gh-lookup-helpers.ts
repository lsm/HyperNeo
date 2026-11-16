import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Logger } from '../logger.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { collectWithMaxBuffer, MAX_BUFFER_BYTES } from '../utils/script-utils.ts';
import {
  computeRateLimitRetryMs,
  isRateLimitError,
  isSecondaryRateLimitError,
  RATE_LIMIT_MIN_BACKOFF_MS,
} from '../session/rate-limit-detector.ts';
import type { ConnectorOutcome } from './connectors/connector.ts';

export const DEFAULT_GH_LOOKUP_TIMEOUT_MS = 30_000;
const log = new Logger('GhLookup');
export type GhResponseQuota = {
  status: number | null;
  resource: string | null;
  remaining: number | null;
  resetAt: number | null;
  retryAfterMs: number | null;
  requestId: string | null;
};

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
    core?: { reset?: number; remaining?: number };
    graphql?: { reset?: number; remaining?: number };
  };
}

export function pickRateLimitResetEpoch(
  payload: RateLimitPayload,
  resource?: 'core' | 'graphql'
): number | null {
  if (resource === 'core') {
    if ((payload.resources?.core?.remaining ?? 0) > 0) return null;
    const reset = payload.resources?.core?.reset;
    return typeof reset === 'number' && Number.isFinite(reset) ? reset : null;
  }
  if (resource === 'graphql') {
    if ((payload.resources?.graphql?.remaining ?? 0) > 0) return null;
    const reset = payload.resources?.graphql?.reset;
    return typeof reset === 'number' && Number.isFinite(reset) ? reset : null;
  }
  const resets: number[] = [];
  const coreReset = payload.resources?.core?.reset;
  const graphqlReset = payload.resources?.graphql?.reset;
  if (
    (payload.resources?.core?.remaining ?? 0) <= 0 &&
    typeof coreReset === 'number' &&
    Number.isFinite(coreReset)
  )
    resets.push(coreReset);
  if (
    (payload.resources?.graphql?.remaining ?? 0) <= 0 &&
    typeof graphqlReset === 'number' &&
    Number.isFinite(graphqlReset)
  )
    resets.push(graphqlReset);
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

// The daemon and every agent share one REST budget; the last core quota a response
// reported is the current estimate until its reset.
let coreBudget: { remaining: number; limit: number; resetAt: number } | null = null;
export function recordGithubBudget(headers: Headers): void {
  const [remaining, limit, reset] = ['remaining', 'limit', 'reset'].map((name) => {
    const value = headers.get(`x-ratelimit-${name}`);
    return value && /^\d+$/.test(value) ? Number(value) : null;
  });
  if (headers.get('x-ratelimit-resource') === 'core' && remaining !== null && limit && reset)
    coreBudget = { remaining, limit, resetAt: reset * 1000 };
}
export function readGithubBudget(now = Date.now()): {
  level: 'ok' | 'low' | 'critical';
  resetAt: number | null;
} {
  if (!coreBudget || now >= coreBudget.resetAt) return { level: 'ok', resetAt: null };
  const share = coreBudget.remaining / coreBudget.limit;
  const level = share < 0.05 ? 'critical' : share < 0.2 ? 'low' : 'ok';
  return { level, resetAt: coreBudget.resetAt };
}

// A matching If-None-Match gets a 304, which does not count against the core limit.
const conditional = new Map<string, { etag: string; data: unknown }>();
const isRestGet = (args: string[]) =>
  args[1] === 'api' &&
  !args.includes('graphql') &&
  !args.includes('--input') &&
  (args.some((arg, i) => ['-X', '--method'].includes(arg) && args[i + 1] === 'GET') ||
    !args.some((arg) => ['-X', '--method', '-f', '-F', '--field', '--raw-field'].includes(arg)));

export async function runGhJson(
  args: string[],
  cwd: string,
  spawnImpl: SpawnFn,
  options?: {
    timeoutMs?: number;
    hostHint?: string;
    resourceHint?: 'core' | 'graphql';
    stripGHRepo?: boolean;
    maxBufferBytes?: number;
    onResponse?: (quota: GhResponseQuota) => void;
    // A `--paginate --slurp` read first asks for one conditional page of 100 and
    // falls back to the full paginated read only when GitHub links a next page.
    firstPage?: boolean;
    onLink?: (link: string | null) => void;
  }
): Promise<ConnectorOutcome> {
  if (
    options?.firstPage &&
    isRestGet(args) &&
    args.includes('--paginate') &&
    args.includes('--slurp')
  ) {
    let more = true;
    const page = await runGhJson(
      [
        ...args.filter((arg) => arg !== '--paginate' && arg !== '--slurp'),
        '--method',
        'GET',
        '-F',
        'per_page=100',
      ],
      cwd,
      spawnImpl,
      { ...options, firstPage: false, onLink: (link) => (more = /rel="next"/.test(link ?? '')) }
    );
    if (!page.ok) return page;
    if (!more) return { ok: true, data: [page.data] };
  }
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GH_LOOKUP_TIMEOUT_MS;
  const key = isRestGet(args) ? JSON.stringify(args) : null;
  const cached = key ? conditional.get(key) : undefined;

  log.info('gh lookup', {
    resource: options?.resourceHint ?? null,
    host: options?.hostHint ?? null,
    tool: args[0] ?? null,
    subcommand: args[1] ?? null,
    endpoint: args.find((arg) => arg.startsWith('repos/')) ?? args[2] ?? null,
  });

  const ghEnv = buildGitHubLookupEnv();
  if (options?.stripGHRepo) delete ghEnv.GH_REPO;

  let proc;
  try {
    const requestArgs =
      args[1] === 'api' && !['--slurp', '--include', '-i'].some((flag) => args.includes(flag))
        ? [...args, '--include']
        : args;
    proc = spawnImpl(
      cached ? [...requestArgs, '-H', `If-None-Match: ${cached.etag}`] : requestArgs,
      {
        cwd,
        env: ghEnv,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
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
    collectWithMaxBuffer(proc.stdout, options?.maxBufferBytes ?? MAX_BUFFER_BYTES),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
    proc.exited,
  ]);

  clearTimeout(killTimer);
  const response = readGhHttpResponse(stdoutResult.text);
  const retryAfter = response?.headers.get('retry-after');
  const retrySeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  const retryAfterMs = Number.isFinite(retrySeconds)
    ? Math.max(0, retrySeconds * 1000)
    : Number.isFinite(retryDate)
      ? Math.max(0, retryDate - Date.now())
      : null;
  const numberHeader = (name: string) => {
    const value = response?.headers.get(name);
    return value !== null && value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  };
  const remaining = numberHeader('x-ratelimit-remaining');
  const reset = numberHeader('x-ratelimit-reset');
  if (response) {
    log.info('gh lookup response', {
      status: response.status,
      resource: response.headers.get('x-ratelimit-resource'),
      remaining,
    });
    options?.onResponse?.({
      status: response.status,
      resource: response.headers.get('x-ratelimit-resource'),
      remaining,
      resetAt: reset === null ? null : reset * 1000,
      retryAfterMs,
      requestId: response.headers.get('x-github-request-id'),
    });
    recordGithubBudget(response.headers);
    options?.onLink?.(response.headers.get('link'));
  }
  if (cached && response?.status === 304) return { ok: true, data: cached.data };

  if (exitCode !== 0) {
    const stderrText = stderrResult.text.trim();
    const errorText = stderrText || `gh exited with code ${exitCode}`;
    if (isRateLimitError(errorText) || retryAfterMs !== null) {
      if (retryAfterMs !== null || isSecondaryRateLimitError(errorText)) {
        return {
          ok: false,
          error: errorText,
          retryable: true,
          retryAfterMs: retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
        };
      }
      const resetEpoch = response
        ? remaining === 0
          ? reset
          : null
        : await fetchRateLimitResetEpoch(
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

  const parsed = stdoutResult.truncated
    ? undefined
    : parseJsonAny(response?.body ?? stdoutResult.text);
  if (parsed === undefined) {
    if (stdoutResult.truncated) {
      return {
        ok: false,
        error: `gh response exceeded the ${options?.maxBufferBytes ?? MAX_BUFFER_BYTES}-byte buffer and was truncated`,
      };
    }
    return {
      ok: false,
      error: 'gh produced empty or non-JSON stdout',
      retryable: true,
      retryAfterMs: RATE_LIMIT_MIN_BACKOFF_MS,
    };
  }
  const etag = response?.headers.get('etag');
  if (key && etag) {
    conditional.delete(key);
    conditional.set(key, { etag, data: parsed });
    if (conditional.size > 500) conditional.delete(conditional.keys().next().value!);
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

export function readGhHttpResponse(
  raw: string
): { status: number; headers: Headers; body: string } | null {
  const boundary = /\r?\n\r?\n/.exec(raw);
  const status = /^HTTP\/\S+\s+(\d{3})\b/.exec(raw);
  if (!boundary || !status) return null;
  const headers = new Headers();
  for (const line of raw.slice(0, boundary.index).split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  return {
    status: Number(status[1]),
    headers,
    body: raw.slice(boundary.index + boundary[0].length),
  };
}
