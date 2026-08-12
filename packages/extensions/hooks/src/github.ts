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
 *
 * NOTE: the GraphQL ops (review threads, review evidence, codex approval) are
 * first-page-only and need online validation in step 7. They are faithful in
 * intent to the retired validators; field details may need real-GitHub tuning.
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

/** Run a GraphQL query via `gh api graphql` and parse the JSON envelope. */
async function runGhGraphql(ctx: HookContext, query: string): Promise<GithubResult<unknown>> {
  const result = await runGh({
    workspacePath: ctx.workspacePath,
    args: ['api', 'graphql', '-f', `query=${query}`],
  });
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.data) };
  } catch {
    return { ok: false, retryable: false, error: 'gh api graphql returned non-JSON output' };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// gh pr view — merge fields
// ---------------------------------------------------------------------------

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
  const v = asRecord(value) ?? {};
  return {
    state: (typeof v.state === 'string' ? v.state : 'CLOSED') as GithubPrView['state'],
    mergeable: (typeof v.mergeable === 'string'
      ? v.mergeable
      : 'UNKNOWN') as GithubPrView['mergeable'],
    mergeStateStatus: typeof v.mergeStateStatus === 'string' ? v.mergeStateStatus : 'UNKNOWN',
  };
}

// ---------------------------------------------------------------------------
// PR link parsing + review threads (pr_ready)
// ---------------------------------------------------------------------------

export interface ParsedPrLink {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** Parse owner/repo/number from a GitHub PR link (any host, including Enterprise). */
export function parsePrLink(link: string): ParsedPrLink | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/.exec(link);
  if (!match) return undefined;
  return {
    host: match[1] as string,
    owner: match[2] as string,
    repo: match[3] as string,
    number: Number(match[4]),
  };
}

/**
 * Unresolved review-conversation URLs on a PR (first page). Drives `pr_ready`'s
 * "no unresolved threads" leg. Owner/repo/number are interpolated into the
 * query after parsing the PR link, so injection is bounded to validated tokens.
 */
export async function ghGetUnresolvedReviewThreads(
  ctx: HookContext,
  link: string
): Promise<GithubResult<string[]>> {
  const pr = parsePrLink(link);
  if (!pr) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  const query =
    `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    'reviewThreads(first: 50) { nodes { isResolved comments(first: 1) { nodes { url } } } } } } }';
  const result = await runGhGraphql(ctx, query);
  if (!result.ok) return result;
  return { ok: true, data: extractUnresolvedThreads(result.data) };
}

function extractUnresolvedThreads(value: unknown): string[] {
  const root = asRecord(value) ?? {};
  const repo = asRecord(asRecord(root.data)?.repository);
  const pr = asRecord(repo?.pullRequest);
  const threads = asRecord(pr?.reviewThreads);
  const nodes = threads?.nodes;
  if (!Array.isArray(nodes)) return [];
  const urls: string[] = [];
  for (const node of nodes) {
    const thread = asRecord(node);
    if (!thread || thread.isResolved !== false) continue;
    const commentNodes = asRecord(asRecord(thread.comments)?.nodes);
    const firstUrl = commentNodes?.url;
    if (typeof firstUrl === 'string') urls.push(firstUrl);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// review evidence (review_posted)
// ---------------------------------------------------------------------------

export interface GithubReviewEvidence {
  /** Formal reviews (APPROVED / CHANGES_REQUESTED) since `sinceIso`. */
  formalReviewCount: number;
  /** PR comments since `sinceIso` (own-PR fallback evidence). */
  commentEvidenceCount: number;
  /** Whether the viewer owns the PR (self-review fallback eligibility). */
  ownPr: boolean;
}

/**
 * Review evidence for the `review_posted` gate: counts formal reviews and
 * comments landed since `sinceIso` (ISO 8601), plus whether the viewer owns the
 * PR. First-page only.
 */
export async function ghGetReviewEvidence(
  ctx: HookContext,
  link: string,
  sinceIso: string
): Promise<GithubResult<GithubReviewEvidence>> {
  const pr = parsePrLink(link);
  if (!pr) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  const query =
    `query { viewer { login } repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    'author { login } reviews(first: 50) { nodes { state publishedAt } } ' +
    'comments(first: 50) { nodes { createdAt } } } } }';
  const result = await runGhGraphql(ctx, query);
  if (!result.ok) return result;
  return { ok: true, data: extractReviewEvidence(result.data, sinceIso) };
}

function extractReviewEvidence(value: unknown, sinceIso: string): GithubReviewEvidence {
  const root = asRecord(value) ?? {};
  const viewerLogin = asRecord(root.viewer)?.login;
  const repo = asRecord(asRecord(root.data)?.repository);
  const pr = asRecord(repo?.pullRequest);
  const authorLogin = asRecord(pr?.author)?.login;
  const ownPr = typeof viewerLogin === 'string' && viewerLogin === authorLogin;

  const reviewNodes = asRecord(asRecord(pr?.reviews)?.nodes);
  let formalReviewCount = 0;
  if (Array.isArray(reviewNodes)) {
    for (const node of reviewNodes) {
      const review = asRecord(node);
      const state = review?.state;
      const publishedAt = review?.publishedAt;
      if (
        (state === 'APPROVED' || state === 'CHANGES_REQUESTED') &&
        typeof publishedAt === 'string' &&
        publishedAt >= sinceIso
      ) {
        formalReviewCount += 1;
      }
    }
  }

  const commentNodes = asRecord(asRecord(pr?.comments)?.nodes);
  let commentEvidenceCount = 0;
  if (Array.isArray(commentNodes)) {
    for (const node of commentNodes) {
      const createdAt = asRecord(node)?.createdAt;
      if (typeof createdAt === 'string' && createdAt >= sinceIso) {
        commentEvidenceCount += 1;
      }
    }
  }

  return { formalReviewCount, commentEvidenceCount, ownPr };
}

// ---------------------------------------------------------------------------
// codex approval (codex_review_approved) — resolves PR from the workspace branch
// ---------------------------------------------------------------------------

export interface GithubCodexApproval {
  approved: boolean;
  prLink?: string;
}

/**
 * Whether a codex review-bot has posted an APPROVED review on the workspace's
 * current PR (resolved from the branch, not a caller-supplied link, so the gate
 * binds to the run's actual PR). First-page reviews only; head-binding is
 * relaxed vs the retired validator (any codex APPROVED review counts). Opt-in.
 */
export async function ghGetCodexApproval(
  ctx: HookContext
): Promise<GithubResult<GithubCodexApproval>> {
  const result = await runGh({
    workspacePath: ctx.workspacePath,
    args: ['pr', 'view', '--json', 'url,reviews'],
  });
  if (!result.ok) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return { ok: false, retryable: false, error: 'gh pr view returned non-JSON output' };
  }
  return { ok: true, data: extractCodexApproval(parsed) };
}

function extractCodexApproval(value: unknown): GithubCodexApproval {
  const pr = asRecord(value) ?? {};
  const prLink = typeof pr.url === 'string' ? pr.url : undefined;
  const nodes = asRecord(pr.reviews)?.nodes;
  if (!Array.isArray(nodes)) return { approved: false, prLink };
  for (const node of nodes) {
    const review = asRecord(node);
    const author = asRecord(review?.author)?.login;
    if (typeof author === 'string' && /codex/i.test(author) && review?.state === 'APPROVED') {
      return { approved: true, prLink };
    }
  }
  return { approved: false, prLink };
}
