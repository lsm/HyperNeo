/**
 * GitHub helper for built-in hooks.
 *
 * A built-in hook runs in-process inside the daemon, so it inherits the daemon's
 * environment and `gh` resolves its own credentials — no mediation, no sandbox.
 * This helper spawns `gh`, parses its JSON, and surfaces rate-limits as a
 * retryable result so a hook can map one to `flow: 'retry'` in one line via
 * {@link githubFailureToFlow}.
 *
 * This is the replacement for the old connector layer. There is deliberately no
 * credential handling here: built-in hooks are trusted code with full daemon
 * access, and pretending otherwise (the old restricted-env sandbox) was theater.
 */

import type { HookContext, HookReturn } from '@hyperneo/shared/types/workflow-hooks';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;

/**
 * Discriminated outcome of a GitHub lookup. `ok:false` carries whether the
 * failure is retryable (rate-limit / transient) so a hook can pick retry vs
 * stop. Rate-limit is an expected outcome of the call, not an exception.
 */
export type GithubResult<T> =
  | { ok: true; data: T }
  | { ok: false; retryable: boolean; error: string; retryAfterMs?: number };

/** Minimal PR view — what `pr_merged` (state) and `pr_ready` (merge fields) need today. */
export interface GithubPrView {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
}

/** Map a retryable/terminal GitHub failure onto a hook flow decision. */
export function githubFailureToFlow(result: {
  ok: false;
  retryable: boolean;
  error: string;
  retryAfterMs?: number;
}): HookReturn {
  return result.retryable
    ? { flow: 'retry', reason: result.error, retryAfterMs: result.retryAfterMs }
    : { flow: 'stop', reason: result.error };
}

function isRateLimit(stderr: string): boolean {
  return /rate limit/i.test(stderr);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readUpTo(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let len = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (len + value.byteLength > maxBytes) break;
      chunks.push(value);
      len += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const merged = new Uint8Array(len);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function runGh(opts: {
  workspacePath: string;
  args: readonly string[];
  timeoutMs?: number;
}): Promise<GithubResult<string>> {
  const { workspacePath, args, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  let proc;
  try {
    proc = Bun.spawn(['gh', ...args], {
      cwd: workspacePath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
  } catch (err) {
    return { ok: false, retryable: false, error: `failed to spawn gh: ${errorMessage(err)}` };
  }

  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      readUpTo(proc.stdout, MAX_OUTPUT_BYTES),
      readUpTo(proc.stderr, MAX_OUTPUT_BYTES),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (exitCode === 0) return { ok: true, data: stdout };
  const errText = stderr.trim();
  if (isRateLimit(errText)) {
    return { ok: false, retryable: true, error: errText || 'gh: rate limited' };
  }
  return { ok: false, retryable: false, error: errText || `gh exited with code ${exitCode}` };
}

/** Fetch a PR's view (state, mergeable, mergeStateStatus) via `gh pr view`. */
export async function ghGetPr(ctx: HookContext, link: string): Promise<GithubResult<GithubPrView>> {
  const result = await runGh({
    workspacePath: ctx.workspacePath,
    args: ['pr', 'view', link, '--json', 'state,mergeable,mergeStateStatus'],
  });
  if (!result.ok) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return { ok: false, retryable: false, error: 'gh pr view returned non-JSON output' };
  }
  return { ok: true, data: parsePrView(parsed) };
}

function parsePrView(value: unknown): GithubPrView {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    state: (typeof v.state === 'string' ? v.state : 'CLOSED') as GithubPrView['state'],
    mergeable: (typeof v.mergeable === 'string'
      ? v.mergeable
      : 'UNKNOWN') as GithubPrView['mergeable'],
    mergeStateStatus: typeof v.mergeStateStatus === 'string' ? v.mergeStateStatus : 'UNKNOWN',
  };
}
