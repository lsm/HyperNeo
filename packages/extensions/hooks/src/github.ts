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
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Keep DRAINING past the cap so the child doesn't block on a full pipe
      // buffer (which would prevent it from exiting until the kill timer) —
      // just stop appending once the budget is reached.
      if (!capped && len + value.byteLength <= maxBytes) {
        chunks.push(value);
        len += value.byteLength;
      } else {
        capped = true;
      }
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
async function runGhGraphqlImpl(
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

/**
 * The GraphQL transport the gh* helpers call. Indirected through this binding
 * so tests can substitute a mock and exercise the pagination loops (the
 * fail-closed caps and multi-page verdict accumulation) without spawning `gh`.
 */
let graphqlRunner: typeof runGhGraphqlImpl = runGhGraphqlImpl;

/** Test seam: substitute (or restore) the GraphQL transport used by the gh* helpers. */
export function setGraphqlRunnerForTests(
  fn: ((ctx: HookContext, query: string, host?: string) => Promise<GithubResult<unknown>>) | null
): void {
  graphqlRunner = fn ?? runGhGraphqlImpl;
}

async function runGhGraphql(
  ctx: HookContext,
  query: string,
  host?: string
): Promise<GithubResult<unknown>> {
  return graphqlRunner(ctx, query, host);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const TRUSTED_GITHUB_HOSTS = new Set(['github.com', 'ghe.com']);
/**
 * A host is trusted if it is a known GitHub host — including any GHE Cloud
 * data-residency tenant (`*.ghe.com`) — or matches the daemon's configured
 * Enterprise host (`GH_HOST`). Prevents an attacker-controlled PR link from
 * redirecting `gh` (and its credentials) at an arbitrary server.
 */
export function isTrustedGitHubHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (TRUSTED_GITHUB_HOSTS.has(normalized)) return true;
  if (normalized.endsWith('.ghe.com')) return true;
  const configured = process.env.GH_HOST?.toLowerCase();
  return !!configured && configured === normalized;
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
  // `gh pr view <url>` resolves the host from the URL, so validate it before
  // invoking gh — an attacker-controlled link must not direct gh (and its
  // credentials) at an arbitrary server.
  const parsedLink = parsePrLink(link);
  if (!parsedLink) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  if (!isTrustedGitHubHost(parsedLink.host)) {
    return {
      ok: false,
      retryable: false,
      error: `refusing gh pr view on untrusted host: ${parsedLink.host}`,
    };
  }
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
 * Unresolved review-conversation URLs on a PR, PAGINATED to the end of the
 * connection. Drives `pr_ready`'s "no unresolved threads" leg — a truncated
 * scan would let a blocker hiding beyond the first page false-pass the gate,
 * so the connection is followed via `pageInfo.endCursor` and the helper fails
 * closed (retryable) when the page cap is exhausted. Owner/repo/number are
 * interpolated into the query after parsing the PR link, and cursors are
 * GitHub base64 (`[A-Za-z0-9+/=]`), so injection is bounded to safe tokens.
 */
const THREADS_PAGE_SIZE = 50;
const MAX_THREAD_PAGES = 10;

export async function ghGetUnresolvedReviewThreads(
  ctx: HookContext,
  link: string
): Promise<GithubResult<string[]>> {
  const pr = parsePrLink(link);
  if (!pr) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  const urls: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const after = cursor ? `after:"${cursor}",` : '';
    const query =
      `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
      `reviewThreads(first: ${THREADS_PAGE_SIZE}, ${after}) { pageInfo { hasNextPage endCursor } ` +
      'nodes { isResolved comments(first: 1) { nodes { url } } } } } } }';
    const result = await runGhGraphql(ctx, query, pr.host);
    if (!result.ok) return result;
    urls.push(...extractUnresolvedThreads(result.data));
    const info = extractThreadsPageInfo(result.data);
    if (info?.hasNextPage !== true) return { ok: true, data: urls };
    if (typeof info?.endCursor !== 'string') break;
    cursor = info.endCursor;
  }
  return {
    ok: false,
    retryable: true,
    error:
      `PR has more than ${MAX_THREAD_PAGES * THREADS_PAGE_SIZE} review threads; ` +
      'unable to scan the full history (fail closed).',
  };
}

/** Read a reviewThreads connection's `pageInfo` from one page of results. */
export function extractThreadsPageInfo(
  value: unknown
): { hasNextPage?: boolean; endCursor?: string } | undefined {
  const root = asRecord(value) ?? {};
  const pr = asRecord(asRecord(asRecord(root.data)?.repository)?.pullRequest);
  const pageInfo = asRecord(asRecord(pr?.reviewThreads)?.pageInfo);
  if (!pageInfo) return undefined;
  return {
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined,
  };
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
  // Query the TAIL of both connections: `first:` returns the EARLIEST page, so
  // on a PR with >50 reviews/comments the fresh evidence this gate needs would
  // fall outside the response and block a completed review. The newest 50 of
  // each is authoritative unless more than 50 landed since the run started —
  // in which case the gate blocks (fail-closed) until evidence re-checks.
  const query =
    `query { viewer { login } repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    'author { login } reviews(last: 50) { nodes { state publishedAt } } ' +
    'comments(last: 50) { nodes { createdAt } } } } }';
  const result = await runGhGraphql(ctx, query, pr.host);
  if (!result.ok) return result;
  return { ok: true, data: extractReviewEvidence(result.data, sinceIso) };
}

/**
 * Compare two ISO-8601 timestamps at matching precision. GitHub returns
 * second-precision timestamps (`12:00:00Z`) while the run-start window may
 * carry milliseconds (`12:00:00.500Z`) — a raw lexical compare then sorts `Z`
 * after `.` and counts a PRE-run item as fresh. Parse to epoch millis instead;
 * an unparseable value never satisfies the window (fail closed).
 */
function atOrAfter(iso: string, sinceIso: string): boolean {
  const at = Date.parse(iso);
  const since = Date.parse(sinceIso);
  return Number.isFinite(at) && Number.isFinite(since) && at >= since;
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
  let commentedReviewEvidence = 0;
  if (Array.isArray(reviewNodes)) {
    for (const node of reviewNodes) {
      const review = asRecord(node);
      const state = review?.state;
      const publishedAt = review?.publishedAt;
      if (
        (state === 'APPROVED' || state === 'CHANGES_REQUESTED') &&
        typeof publishedAt === 'string' &&
        atOrAfter(publishedAt, sinceIso)
      ) {
        formalReviewCount += 1;
      }
      // Own-PR evidence: GitHub rejects self-approval, and the Reviewer System
      // Contract tells the reviewer to submit a COMMENT review instead, which
      // GitHub records as state COMMENTED. Count those like conversation
      // comments so the prescribed own-PR procedure satisfies the gate.
      if (
        state === 'COMMENTED' &&
        typeof publishedAt === 'string' &&
        atOrAfter(publishedAt, sinceIso)
      ) {
        commentedReviewEvidence += 1;
      }
    }
  }

  const commentNodes = asRecord(pr?.comments)?.nodes;
  let commentEvidenceCount = 0;
  if (Array.isArray(commentNodes)) {
    for (const node of commentNodes) {
      const createdAt = asRecord(node)?.createdAt;
      if (typeof createdAt === 'string' && atOrAfter(createdAt, sinceIso)) {
        commentEvidenceCount += 1;
      }
    }
  }

  return {
    formalReviewCount,
    commentEvidenceCount: commentEvidenceCount + commentedReviewEvidence,
    ownPr,
  };
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
 * `chatgpt-codex-connector[bot]` on reactions. Match EXACTLY the two documented
 * forms (not on `__typename`, which differs between the two) so both count,
 * while a human whose login merely contains the slug (e.g.
 * `chatgpt-codex-connector-x`) does not.
 */
const CODEX_BOT_LOGINS = new Set(['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]']);

function isCodexActor(author: unknown): boolean {
  const login = asRecord(author)?.login;
  return typeof login === 'string' && CODEX_BOT_LOGINS.has(login);
}

/**
 * Whether codex has approved the run's PR — HEAD-SPECIFICALLY. The PR is the
 * run's authoritative reviewed link (read from the `pr_ready`-stamped artifact),
 * not a branch guess, so a stray `GH_REPO` cannot redirect it. The gate's whole
 * purpose is approval of the CURRENT head, so both pass paths bind to the head:
 *   - the LATEST head-bound codex review is AUTHORITATIVE when one exists at
 *     all: it must be APPROVED (a later CHANGES_REQUESTED on the same head
 *     overrides an earlier APPROVED, and a stale review from a prior head does
 *     not count). The reviews connection is PAGINATED to a bounded cap (a
 *     prefix is not authoritative: a later CHANGES_REQUESTED beyond the first
 *     page would flip the verdict), and the gate fails closed when the cap is
 *     exhausted;
 *   - only when NO head-bound codex review exists: a THUMBS_UP (+1) reaction
 *     from the codex bot with `createdAt` newer than the head commit's
 *     `pushedDate` (push time, not commit-authoring time — selected on the
 *     Commit object; the GraphQL schema has no `PullRequest.pushedDate`, and
 *     selecting one errors the whole query). The reaction connection reads the
 *     TAIL (last: 50) so a fresh +1 is not pushed out by older reactions.
 * The reaction actor is User-typed with a `[bot]` suffix; the login match covers
 * both forms. Opt-in. Fails closed when the head can't be resolved (the gate
 * can't prove head-specificity, so it retries).
 */
const CODEX_REVIEWS_PAGE_SIZE = 50;
const MAX_CODEX_REVIEW_PAGES = 10;

export async function ghGetCodexApproval(
  ctx: HookContext,
  link: string
): Promise<GithubResult<GithubCodexApproval>> {
  const pr = parsePrLink(link);
  if (!pr) {
    return { ok: false, retryable: false, error: `unable to parse GitHub PR link: ${link}` };
  }
  const headQuery = (after: string | null) =>
    `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    `reviews(first: ${CODEX_REVIEWS_PAGE_SIZE}${after ? `, after:"${after}"` : ''}) { ` +
    'pageInfo { hasNextPage endCursor } ' +
    'nodes { state author { login } commit { oid } body submittedAt } } ' +
    // Reaction TAIL (last: 50, not first:) — `first:` returns the earliest page,
    // so on a PR with >50 thumbs the fresh codex +1 would fall outside it.
    'reactions(last: 50, content: THUMBS_UP) { nodes { createdAt user { login } } } ' +
    'commits(last: 1) { nodes { commit { oid pushedDate } } } } } }';

  const allReviewNodes: unknown[] = [];
  let lastPage: Record<string, unknown> | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CODEX_REVIEW_PAGES; page++) {
    const result = await runGhGraphql(ctx, headQuery(cursor), pr.host);
    if (!result.ok) return result;
    lastPage = asRecord(result.data) ?? {};
    const prNode = asRecord(asRecord(asRecord(lastPage.data)?.repository)?.pullRequest);
    const nodes = asRecord(prNode?.reviews)?.nodes;
    if (Array.isArray(nodes)) allReviewNodes.push(...nodes);
    const pageInfo = asRecord(asRecord(prNode?.reviews)?.pageInfo);
    if (pageInfo?.hasNextPage !== true) {
      // Definitive end of the review history — evaluate the merged document.
      return {
        ok: true,
        data: extractCodexApproval(
          {
            data: {
              repository: { pullRequest: { ...prNode, reviews: { nodes: allReviewNodes } } },
            },
          },
          link
        ),
      };
    }
    if (typeof pageInfo?.endCursor !== 'string') break;
    cursor = pageInfo.endCursor;
  }
  return {
    ok: false,
    retryable: true,
    error:
      `PR has more than ${MAX_CODEX_REVIEW_PAGES * CODEX_REVIEWS_PAGE_SIZE} reviews; ` +
      'unable to scan the full codex review history (fail closed).',
  };
}

export function extractCodexApproval(value: unknown, prLink: string): GithubCodexApproval {
  const root = asRecord(value) ?? {};
  const pr = asRecord(asRecord(asRecord(root.data)?.repository)?.pullRequest);

  // Head SHA (for review head-binding) + the head commit's push time (for
  // reaction freshness). `pushedDate` is a Commit field — the schema has no
  // PullRequest.pushedDate — so it is selected on (and read from) the last
  // commit. Use pushedDate, not commit.committedDate — a locally-created commit
  // pushed later has an early committedDate but a late push, which would
  // otherwise let a pre-push +1 false-pass.
  const commitNodes = asRecord(pr?.commits)?.nodes;
  const headCommit = Array.isArray(commitNodes)
    ? asRecord(asRecord(commitNodes[commitNodes.length - 1])?.commit)
    : undefined;
  const headOid = typeof headCommit?.oid === 'string' ? headCommit.oid : undefined;
  const pushedDate = typeof headCommit?.pushedDate === 'string' ? headCommit.pushedDate : undefined;

  // Pass path 1: the LATEST DECISIVE head-bound codex review (APPROVED or
  // CHANGES_REQUESTED) is AUTHORITATIVE — a prior APPROVED must not satisfy the
  // gate if codex later posted CHANGES_REQUESTED on the same head, so we take
  // the newest decisive head-bound codex review (by submittedAt). When one
  // exists, its state alone decides and the reaction path does not run: an
  // earlier thumbs-up must not override a later explicit CHANGES_REQUESTED on
  // the same head. A COMMENTED review carries no verdict and does not block
  // the reaction path.
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
      if (!submittedAt || (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED')) continue;
      if (!latest || submittedAt > latest.submittedAt) latest = { submittedAt, state };
    }
    if (latest) return { approved: latest.state === 'APPROVED', prLink };
  }

  // Pass path 2 (no head-bound codex review at all): a FRESH THUMBS_UP (+1)
  // reaction from the codex bot — createdAt newer than the head PUSH (compared
  // at matching precision; see atOrAfter). A stale +1 from a prior head must
  // not false-pass, and this path only runs when path 1 found no codex review
  // whose verdict could dominate.
  const reactionNodes = asRecord(pr?.reactions)?.nodes;
  if (Array.isArray(reactionNodes) && typeof pushedDate === 'string') {
    const pushedMs = Date.parse(pushedDate);
    for (const node of reactionNodes) {
      const reaction = asRecord(node);
      const createdAt = reaction?.createdAt;
      // STRICTLY newer than the head push, compared at epoch precision —
      // second-precision strings never mis-order against millisecond ones.
      if (typeof createdAt !== 'string') continue;
      const createdMs = Date.parse(createdAt);
      if (!Number.isFinite(createdMs) || !Number.isFinite(pushedMs)) continue;
      if (createdMs <= pushedMs) continue;
      if (isCodexActor(reaction?.user)) {
        return { approved: true, prLink };
      }
    }
  }

  return { approved: false, prLink };
}
