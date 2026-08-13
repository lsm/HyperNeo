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
  return /rate limit|secondary rate limit/i.test(stderr);
}

/** Transient gh CLI failures worth retrying (network blips, 5xx, DNS). */
const TRANSIENT_FAILURE =
  /network|timeout|timed out|connection|econnreset|enotfound|ehostunreach|temporar|try again|\b5\d{2}\b|bad gateway|service unavailable|gateway timeout/i;
function isTransientFailure(stderr: string, exitCode: number | null): boolean {
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) return true; // gh uses 1 for most errors; ≥2 is often a crash/infra failure
  return TRANSIENT_FAILURE.test(stderr);
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
  if (isTransientFailure(errText, exitCode)) {
    return {
      ok: false,
      retryable: true,
      error: errText || `gh transient failure (exit ${exitCode})`,
    };
  }
  return { ok: false, retryable: false, error: errText || `gh exited with code ${exitCode}` };
}

/**
 * Run a GraphQL query via `gh api graphql` and parse the JSON envelope. `host`
 * routes the request to the PR's GitHub host (github.com or an Enterprise
 * instance); without it `gh` targets its configured default host, which is wrong
 * for Enterprise PRs. The host is validated against a trusted set so an
 * attacker-controlled PR link cannot redirect `gh` (and its credentials) at an
 * arbitrary server. Envelopes carrying a top-level `errors` array are rejected.
 */
async function runGhGraphql(
  ctx: HookContext,
  query: string,
  host?: string
): Promise<GithubResult<unknown>> {
  const args = ['api', 'graphql'];
  if (host) {
    if (!isTrustedGitHubHost(host)) {
      return {
        ok: false,
        retryable: false,
        error: `refusing GraphQL call to untrusted host: ${host}`,
      };
    }
    args.push('--hostname', host);
  }
  args.push('-f', `query=${query}`);
  const result = await runGh({
    workspacePath: ctx.workspacePath,
    args,
  });
  if (!result.ok) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    return { ok: false, retryable: false, error: 'gh api graphql returned non-JSON output' };
  }
  const envelope = asRecord(parsed);
  const errors = envelope?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    // A rate-limit / transient error inside an otherwise-200 GraphQL response
    // must stay retryable (so hooks map it to flow:'retry'), not terminal.
    const text = JSON.stringify(errors);
    const retryable = isRateLimit(text) || TRANSIENT_FAILURE.test(text);
    return { ok: false, retryable, error: `GraphQL errors: ${text}` };
  }
  return { ok: true, data: parsed };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const TRUSTED_GITHUB_HOSTS = new Set(['github.com', 'ghe.com']);
/**
 * A host is trusted if it is a known GitHub host, or matches the daemon's
 * configured Enterprise host (`GH_HOST`). Prevents an attacker-controlled PR
 * link from redirecting `gh` (and its credentials) at an arbitrary server.
 */
function isTrustedGitHubHost(host: string): boolean {
  if (TRUSTED_GITHUB_HOSTS.has(host)) return true;
  const configured = process.env.GH_HOST;
  return !!configured && configured === host;
}

// ---------------------------------------------------------------------------
// gh pr view — merge fields
// ---------------------------------------------------------------------------

/** Fetch a PR's view (state, mergeable, mergeStateStatus) via `gh pr view`. */
export async function ghGetPr(ctx: HookContext, link: string): Promise<GithubResult<GithubPrView>> {
  return fetchPrView(ctx.workspacePath, link);
}

/**
 * Workspace-path-only PR view fetch, for daemon callers that are not inside a
 * hook run (e.g. the coder-owned-merge `mark_complete` gate) but reuse this
 * extensions-owned GitHub helper rather than the daemon re-implementing `gh`.
 */
export async function fetchPrView(
  workspacePath: string,
  link: string
): Promise<GithubResult<GithubPrView>> {
  const result = await runGh({
    workspacePath,
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

export function parsePrView(value: unknown): GithubPrView {
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

/**
 * GitHub owner/repo slug charset. Restricting the parsed tokens to this set
 * prevents GraphQL injection — owner/repo are interpolated raw into the query
 * string, and the link is agent-supplied (prompt-injectable), so a crafted
 * owner/repo containing `"`/`\` could otherwise break out of the GraphQL string
 * and run arbitrary fields with the daemon's gh token.
 */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Parse owner/repo/number from a GitHub PR link (any host, including Enterprise).
 * Returns undefined when the link doesn't match the PR shape OR owner/repo
 * contain characters outside the GitHub slug charset (injection guard).
 */
export function parsePrLink(link: string): ParsedPrLink | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/.exec(link);
  if (!match) return undefined;
  const owner = match[2] as string;
  const repo = match[3] as string;
  if (!SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return undefined;
  return {
    host: match[1] as string,
    owner,
    repo,
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
  const result = await runGhGraphql(ctx, query, pr.host);
  if (!result.ok) return result;
  return { ok: true, data: extractUnresolvedThreads(result.data) };
}

export function extractUnresolvedThreads(value: unknown): string[] {
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
    // `comments` is a GraphQL connection: { nodes: [...] }. Index the array —
    // asRecord() rejects arrays, so reading it as a record silently dropped
    // every thread URL (the gate always saw zero unresolved threads).
    const commentNodes = asRecord(thread.comments)?.nodes;
    const firstComment = Array.isArray(commentNodes) ? asRecord(commentNodes[0]) : undefined;
    const firstUrl = firstComment?.url;
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
  const result = await runGhGraphql(ctx, query, pr.host);
  if (!result.ok) return result;
  return { ok: true, data: extractReviewEvidence(result.data, sinceIso) };
}

export function extractReviewEvidence(value: unknown, sinceIso: string): GithubReviewEvidence {
  const root = asRecord(value) ?? {};
  // GraphQL response: { data: { viewer, repository: { pullRequest } } }. Both
  // `viewer` and `repository` live under `data` — reading `viewer` from the
  // root silently made ownPr always false, defeating the self-PR comment fallback.
  const dataEnvelope = asRecord(root.data);
  const viewerLogin = asRecord(dataEnvelope?.viewer)?.login;
  const repo = asRecord(dataEnvelope?.repository);
  const pr = asRecord(repo?.pullRequest);
  const authorLogin = asRecord(pr?.author)?.login;
  const ownPr = typeof viewerLogin === 'string' && viewerLogin === authorLogin;

  // `reviews` / `comments` are GraphQL connections: { nodes: [...] }. Read the
  // array directly — wrapping it in asRecord() rejects arrays and silently zeroed
  // both counts.
  const reviewNodes = asRecord(pr?.reviews)?.nodes;
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

  const commentNodes = asRecord(pr?.comments)?.nodes;
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
// codex approval (codex_review_approved) — link-driven GraphQL
// ---------------------------------------------------------------------------

export interface GithubCodexApproval {
  approved: boolean;
  prLink?: string;
}

/**
 * The codex review-bot's login slug. The bot surfaces in TWO forms: as a `Bot`
 * `chatgpt-codex-connector` on review comments, and as a `User`
 * `chatgpt-codex-connector[bot]` on reactions. Match on the slug (not on
 * `__typename`, which differs between the two) so both count, and so a human
 * merely named "codex" does not.
 */
const CODEX_BOT_LOGIN = /chatgpt-codex-connector/i;

function isCodexActor(author: unknown): boolean {
  const login = asRecord(author)?.login;
  return typeof login === 'string' && CODEX_BOT_LOGIN.test(login);
}

/**
 * Whether codex has approved the run's PR — HEAD-SPECIFICALLY. The PR is the
 * run's authoritative reviewed link (read from the `pr_ready`-stamped artifact),
 * not a branch guess, so a stray `GH_REPO` cannot redirect it. The gate's whole
 * purpose is approval of the CURRENT head, so both pass paths bind to the head:
 *   - the LATEST decisive codex review whose `commit.oid` is the head SHA (or
 *     whose body names the 40-char head SHA) must be APPROVED — a later
 *     CHANGES_REQUESTED on the same head overrides an earlier APPROVED, and a
 *     stale review from a prior head does not count;
 *   - a THUMBS_UP (+1) reaction from the codex bot with `createdAt` newer than
 *     the PR's `pushedDate` (push time, not commit-authoring time).
 * The reaction actor is User-typed with a `[bot]` suffix; the login match covers
 * both forms. First-page only; opt-in. Fails closed when the head can't be
 * resolved (the gate can't prove head-specificity, so it retries).
 */
export async function ghGetCodexApproval(
  ctx: HookContext,
  link: string
): Promise<GithubResult<GithubCodexApproval>> {
  const pr = parsePrLink(link);
  if (!pr) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  const query =
    `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    'pushedDate ' +
    'reviews(first: 50) { nodes { state author { login } commit { oid } body submittedAt } } ' +
    'reactions(first: 50, content: THUMBS_UP) { nodes { createdAt user { login } } } ' +
    'commits(last: 1) { nodes { commit { oid } } } } } }';
  const result = await runGhGraphql(ctx, query, pr.host);
  if (!result.ok) return result;
  return { ok: true, data: extractCodexApproval(result.data, link) };
}

export function extractCodexApproval(value: unknown, prLink: string): GithubCodexApproval {
  const root = asRecord(value) ?? {};
  const pr = asRecord(asRecord(asRecord(root.data)?.repository)?.pullRequest);

  // Head SHA (for review head-binding) + the PR's last push time (for reaction
  // freshness). Use pushedDate, not commit.committedDate — a locally-created
  // commit pushed later has an early committedDate but a late push, which would
  // otherwise let a pre-push +1 false-pass.
  const commitNodes = asRecord(pr?.commits)?.nodes;
  const headCommit = Array.isArray(commitNodes)
    ? asRecord(asRecord(commitNodes[commitNodes.length - 1])?.commit)
    : undefined;
  const headOid = typeof headCommit?.oid === 'string' ? headCommit.oid : undefined;
  const pushedDate = typeof pr?.pushedDate === 'string' ? pr.pushedDate : undefined;

  // Pass path 1: the LATEST decisive codex review on the current head. A prior
  // APPROVED must not satisfy the gate if codex later posted CHANGES_REQUESTED
  // on the same head, so we take the newest head-bound codex review (by
  // submittedAt) and require it to be APPROVED.
  const reviewNodes = asRecord(pr?.reviews)?.nodes;
  if (Array.isArray(reviewNodes) && typeof headOid === 'string') {
    let latest: { submittedAt: string; state: string } | null = null;
    for (const node of reviewNodes) {
      const review = asRecord(node);
      if (!isCodexActor(review?.author)) continue;
      const reviewOid = asRecord(review?.commit)?.oid;
      const body = typeof review?.body === 'string' ? review.body : '';
      const onHead = reviewOid === headOid || body.includes(headOid);
      if (!onHead) continue;
      const submittedAt = typeof review?.submittedAt === 'string' ? review.submittedAt : '';
      const state = typeof review?.state === 'string' ? review.state : '';
      if (!submittedAt) continue;
      if (!latest || submittedAt > latest.submittedAt) latest = { submittedAt, state };
    }
    if (latest?.state === 'APPROVED') return { approved: true, prLink };
  }

  // Pass path 2: a FRESH THUMBS_UP (+1) reaction from the codex bot — createdAt
  // newer than the head PUSH. A stale +1 from a prior head must not false-pass.
  const reactionNodes = asRecord(pr?.reactions)?.nodes;
  if (Array.isArray(reactionNodes) && typeof pushedDate === 'string') {
    for (const node of reactionNodes) {
      const reaction = asRecord(node);
      const createdAt = reaction?.createdAt;
      if (typeof createdAt !== 'string' || createdAt <= pushedDate) continue;
      if (isCodexActor(reaction?.user)) {
        return { approved: true, prLink };
      }
    }
  }

  return { approved: false, prLink };
}
