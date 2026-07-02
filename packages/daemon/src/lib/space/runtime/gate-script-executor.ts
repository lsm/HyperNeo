/**
 * Gate Script Executor
 *
 * Executes optional gate scripts (bash/node/python3) as imperative pre-checks
 * before declarative field evaluation. Scripts run in a restricted environment
 * with credential stripping, prototype-pollution-safe JSON stdout merging,
 * streaming maxBuffer enforcement, and timeout-based SIGKILL.
 *
 * Exit 0 → parse JSON stdout, deep-merge into gate data → continue
 * Non-zero / timeout → gate blocked (stderr as reason)
 */

import type { GateScript } from '@hyperneo/shared';
import { isRateLimitError, RATE_LIMIT_MIN_BACKOFF_MS } from './rate-limit-detector';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of executing a gate script. */
export interface GateScriptResult {
  /** Whether the script passed (exit 0 with parseable stdout). */
  success: boolean;
  /** Parsed JSON data from stdout (deep-merged). Empty object when no JSON. */
  data: Record<string, unknown>;
  /** Human-readable error string on failure (stderr or timeout message). */
  error?: string;
  /**
   * True when the script's stderr matched a GitHub rate-limit signature.
   *
   * Surfaced so callers (gate evaluator, workflow engine) can defer re-evaluation
   * instead of re-running the failing script on every gate write. The script
   * still counts as a failure (`success: false`); this flag is informational
   * and does not change the pass/fail verdict on its own.
   */
  rateLimited?: boolean;
  /**
   * Suggested backoff in milliseconds when `rateLimited` is true.
   *
   * Bash gate scripts cannot read the `X-RateLimit-Reset` header directly, so
   * this defaults to `RATE_LIMIT_MIN_BACKOFF_MS` whenever rate-limiting is
   * detected. Consumers may override with a more precise value when they have
   * reset-window context (e.g. the pr-ready validator probes
   * `gh api /rate_limit`).
   */
  retryAfterMs?: number;
}

/** Context provided to the script executor. */
export interface GateScriptContext {
  /** Absolute path to the workspace root (used as cwd). */
  workspacePath: string;
  /** The gate ID this script belongs to. */
  gateId: string;
  /** The current workflow run ID. */
  runId: string;
  /**
   * Current gate runtime data used for evaluation.
   * Exposed to scripts as HYPERNEO_GATE_DATA_JSON.
   */
  gateData?: Record<string, unknown>;
  /**
   * ISO8601 timestamp marking when the workflow run started (workflowRun.createdAt
   * converted to ISO8601). Exposed to scripts as HYPERNEO_WORKFLOW_START_ISO.
   * Gate scripts that compare against fresh activity (e.g. reviews submitted
   * since start) rely on this variable.
   * Undefined when the context wasn't able to resolve a run start time
   * (e.g. in unit tests); the env var is only injected when set.
   */
  workflowStartIso?: string;
  /**
   * ISO8601 timestamp marking when the current gate data was last updated.
   * Exposed as HYPERNEO_GATE_DATA_UPDATED_ISO for checks whose timeout window
   * starts when approval data is written, not when the workflow run starts.
   */
  gateDataUpdatedIso?: string;
  /**
   * Resolved PR URL for the current workflow run, if known.
   * Injected into the script environment as `PR_URL` so feature scripts
   * (e.g. codex reaction checks) can access the PR even when the gate's
   * own data does not contain `pr_url`.
   */
  prUrl?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout for gate scripts (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum stdout/stderr buffer size (1 MB). */
export const MAX_BUFFER_BYTES = 1_048_576;

/**
 * Environment variable prefixes that are stripped from the restricted env.
 * These carry credentials, auth tokens, and internal secrets.
 */
const RESTRICTED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'GLM_',
  'ZHIPU_',
  'COPILOT_',
  'HYPERNEO_',
  'NEOKAI_',
];

/**
 * Environment variable keys matching this regex are stripped from the restricted env.
 * Catches keys like `MY_SECRET`, `API_TOKEN`, `DB_PASSWORD`, `AWS_CREDENTIAL`.
 */
const RESTRICTED_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i;

/**
 * Gate-specific env vars injected into every gate/hook script under the canonical
 * `HYPERNEO_*` names (a legacy `NEOKAI_*` alias is mirrored alongside each).
 */
const GATE_INJECTED_ENV_KEYS = [
  'HYPERNEO_GATE_ID',
  'HYPERNEO_WORKFLOW_RUN_ID',
  'HYPERNEO_WORKSPACE_PATH',
  'HYPERNEO_GATE_DATA_JSON',
  'HYPERNEO_WORKFLOW_START_ISO',
  'HYPERNEO_GATE_DATA_UPDATED_ISO',
] as const;

/** True for a canonical or legacy gate-injected env key (user scriptEnv cannot override these). */
function isGateInjectedEnvKey(key: string): boolean {
  if ((GATE_INJECTED_ENV_KEYS as readonly string[]).includes(key)) return true;
  return GATE_INJECTED_ENV_KEYS.some((k) => key === `NEOKAI_${k.slice('HYPERNEO_'.length)}`);
}

/**
 * Environment variables that are always allowed regardless of the prefix/key pattern.
 */
const ALLOWED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'HYPERNEO_VALIDATION_BASE_REF',
]);

/** Keys that are rejected during deep-merge to prevent prototype pollution. */
const PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Environment filtering
// ---------------------------------------------------------------------------

/**
 * Builds a restricted environment object from the current process environment.
 *
 * Strips variables whose names match restricted prefixes or patterns while
 * always allowing a safe allowlist. Then injects gate-specific variables.
 */
export function buildRestrictedEnv(
  context: GateScriptContext,
  scriptEnv?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;

    if (ALLOWED_ENV_KEYS.has(key)) {
      env[key] = value;
      continue;
    }

    const isPrefixRestricted = RESTRICTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (isPrefixRestricted) continue;

    const isKeyRestricted = RESTRICTED_ENV_KEY_PATTERN.test(key);
    if (isKeyRestricted) continue;

    env[key] = value;
  }

  // Inject gate-specific environment variables
  env['HYPERNEO_GATE_ID'] = context.gateId;
  env['HYPERNEO_WORKFLOW_RUN_ID'] = context.runId;
  env['HYPERNEO_WORKSPACE_PATH'] = context.workspacePath;

  if (context.workflowStartIso) {
    env['HYPERNEO_WORKFLOW_START_ISO'] = context.workflowStartIso;
  }
  if (context.gateDataUpdatedIso) {
    env['HYPERNEO_GATE_DATA_UPDATED_ISO'] = context.gateDataUpdatedIso;
  }

  if (context.prUrl) {
    env['PR_URL'] = context.prUrl;
  }

  const gateData = context.gateData ?? {};
  try {
    env['HYPERNEO_GATE_DATA_JSON'] = JSON.stringify(gateData);
  } catch {
    env['HYPERNEO_GATE_DATA_JSON'] = '{}';
  }

  // Backward-compat: mirror the injected gate vars under legacy NEOKAI_* aliases
  // so gate/hook scripts authored before the HyperNeo rename keep seeing values.
  for (const hyperneoKey of GATE_INJECTED_ENV_KEYS) {
    if (env[hyperneoKey] !== undefined) {
      env[`NEOKAI_${hyperneoKey.slice('HYPERNEO_'.length)}`] = env[hyperneoKey];
    }
  }

  // Resolve the validation base override from either name and expose both, so
  // bundled scripts (HYPERNEO_VALIDATION_BASE_REF) and upgraded custom scripts
  // still reading the legacy NEOKAI_VALIDATION_BASE_REF both see it.
  const validationBaseRef =
    env['HYPERNEO_VALIDATION_BASE_REF'] ?? process.env.NEOKAI_VALIDATION_BASE_REF;
  if (validationBaseRef !== undefined) {
    env['HYPERNEO_VALIDATION_BASE_REF'] = validationBaseRef;
    env['NEOKAI_VALIDATION_BASE_REF'] = validationBaseRef;
  }

  // Merge user-specified env (applied after injected vars; cannot override gate-injected vars)
  if (scriptEnv) {
    for (const [key, value] of Object.entries(scriptEnv)) {
      // User env cannot override gate-injected vars (HYPERNEO_* or legacy NEOKAI_* alias)
      if (isGateInjectedEnvKey(key)) {
        continue;
      }
      if (!ALLOWED_ENV_KEYS.has(key)) {
        // User env cannot carry credentials
        const isPrefixRestricted = RESTRICTED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
        if (isPrefixRestricted) continue;
        const isKeyRestricted = RESTRICTED_ENV_KEY_PATTERN.test(key);
        if (isKeyRestricted) continue;
      }

      env[key] = value;
    }
  }

  return env;
}

// ---------------------------------------------------------------------------
// Deep merge with depth limit (prototype-pollution safe)
// ---------------------------------------------------------------------------

/**
 * Deep-merges `source` into `target` with a configurable depth limit.
 *
 * Rejects `__proto__`, `constructor`, and `prototype` keys at every level
 * to prevent prototype pollution attacks from malicious script output.
 *
 * @param target  The target object to merge into.
 * @param source  The source object to merge from.
 * @param maxDepth  Maximum recursion depth (default 5).
 * @returns The merged target object.
 */
export function deepMergeWithDepthLimit(
  target: Record<string, unknown>,
  source: unknown,
  maxDepth = 5
): Record<string, unknown> {
  return _deepMerge(target, source, 0, maxDepth);
}

function _deepMerge(
  target: Record<string, unknown>,
  source: unknown,
  currentDepth: number,
  maxDepth: number
): Record<string, unknown> {
  if (
    currentDepth >= maxDepth ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    return target;
  }

  const sourceRecord = source as Record<string, unknown>;

  for (const [key, value] of Object.entries(sourceRecord)) {
    // Block prototype pollution keys
    if (PROTO_POLLUTION_KEYS.has(key)) {
      continue;
    }

    const existing = target[key];

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      target[key] = _deepMerge(
        existing as Record<string, unknown>,
        value,
        currentDepth + 1,
        maxDepth
      );
    } else {
      target[key] = value;
    }
  }

  return target;
}

// ---------------------------------------------------------------------------
// JSON stdout parsing
// ---------------------------------------------------------------------------

/**
 * Parses raw stdout from a script as JSON.
 *
 * Returns the parsed object on success, or `null` if the output is empty,
 * whitespace-only, or not valid JSON. Errors are silently swallowed so that
 * non-JSON output does not block the gate.
 */
export function parseJsonStdout(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Valid JSON but not an object (e.g., string, number, array) — ignore
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stream helper — collect with maxBuffer enforcement
// ---------------------------------------------------------------------------

/**
 * Collects chunks from a ReadableStream, enforcing a maximum byte limit.
 * Once the limit is exceeded, the stream continues draining to avoid pipe
 * deadlock, but no further data is appended.
 */
export async function collectWithMaxBuffer(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) {
    return { text: '', truncated: false };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (truncated) {
        // Already exceeded limit — keep draining to avoid deadlock
        continue;
      }

      if (totalBytes + value.length > maxBytes) {
        // Take only what fits up to the limit
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        }
        totalBytes = maxBytes;
        truncated = true;
      } else {
        chunks.push(decoder.decode(value, { stream: true }));
        totalBytes += value.length;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  return { text: chunks.join(''), truncated };
}

// ---------------------------------------------------------------------------
// Script executor
// ---------------------------------------------------------------------------

/**
 * Executes a gate script and returns the result.
 *
 * Uses `Bun.spawn()` in array form (never shell interpolation). Supports bash,
 * node, and python3 interpreters. Runs in a restricted environment with
 * credential stripping, streaming maxBuffer enforcement, and timeout-based
 * SIGKILL.
 *
 * @param script   The gate script definition.
 * @param context  Execution context (workspace path, gate ID, run ID).
 * @param env      Optional user-specified environment variables (filtered).
 */
export async function executeGateScript(
  script: GateScript,
  context: GateScriptContext,
  env?: Record<string, string>
): Promise<GateScriptResult> {
  const timeoutMs = script.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build the command args array based on interpreter
  let args: string[];
  switch (script.interpreter) {
    case 'bash':
      args = ['bash', '-c', script.source];
      break;
    case 'node':
      args = ['node', '-e', script.source];
      break;
    case 'python3':
      args = ['python3', '-c', script.source];
      break;
    default:
      return {
        success: false,
        data: {},
        error: `Unknown interpreter: ${script.interpreter as string}`,
      };
  }

  const restrictedEnv = buildRestrictedEnv(context, env);

  let proc;
  try {
    proc = Bun.spawn(args, {
      cwd: context.workspacePath,
      env: restrictedEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: {},
      error: `Failed to spawn ${script.interpreter}: ${message}`,
    };
  }

  // Drain stdout and stderr concurrently with proc.exited to avoid pipe deadlock
  // NOTE: SIGKILL on bash -c only kills the shell, not child processes (e.g. sleep).
  // This is a known bash limitation. Gate scripts that spawn long-lived children
  // should manage their own cleanup on SIGTERM-like signals. Process group kill
  // (-proc.pid) is not used here because Bun.spawn may not always assign a usable PID.
  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    collectWithMaxBuffer(proc.stdout, MAX_BUFFER_BYTES),
    collectWithMaxBuffer(proc.stderr, MAX_BUFFER_BYTES),
    (async () => {
      let killed = false;
      const killTimer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      const code = await proc.exited;
      clearTimeout(killTimer);

      return { code, timedOut: killed };
    })(),
  ]);

  if (exitCode.timedOut) {
    return {
      success: false,
      data: {},
      error: `Script timed out after ${timeoutMs}ms`,
    };
  }

  if (exitCode.code !== 0) {
    const stderrText = stderrResult.text.trim();
    const rateLimited = isRateLimitError(stderrText);
    return {
      success: false,
      data: {},
      error: rateLimited
        ? `GitHub rate limit: ${stderrText}`
        : stderrText || `Script exited with code ${exitCode.code}`,
      rateLimited,
      // Bash scripts cannot read X-RateLimit-Reset directly; fall back to the
      // minimum backoff. Consumers with reset-window context can override.
      retryAfterMs: rateLimited ? RATE_LIMIT_MIN_BACKOFF_MS : undefined,
    };
  }

  // Exit 0 — parse JSON stdout and merge
  const parsed = parseJsonStdout(stdoutResult.text);
  const data = parsed ? deepMergeWithDepthLimit({}, parsed) : {};

  return {
    success: true,
    data,
  };
}
