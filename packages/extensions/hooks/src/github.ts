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
 * NOTE: the GraphQL ops (review threads, review evidence, codex approval)
 * paginate with fail-closed caps and are covered by extractor/pagination
 * tests; live-GitHub validation of field shapes remains outstanding.
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

/**
 * Prefix marking a TERMINAL GitHub lookup failure (auth missing, malformed
 * response, untrusted host) as an infrastructure error rather than a policy
 * decision — the hook never completed its lookup, so a human approval must
 * not deliver through it. The daemon engine recognizes this prefix (and its
 * own execution-error prefix) as override-ineligible.
 */
export const GH_INFRA_ERROR_PREFIX = '__gh_infra_error__: ';

/** Map a retryable/terminal GitHub failure onto a hook flow decision. */
export function githubFailureToFlow(result: {
  ok: false;
  retryable: boolean;
  error: string;
  retryAfterMs?: number;
}): HookReturn {
  return result.retryable
    ? { flow: 'retry', reason: result.error, retryAfterMs: result.retryAfterMs }
    : { flow: 'stop', reason: GH_INFRA_ERROR_PREFIX + result.error };
}

function isRateLimit(stderr: string): boolean {
  return /rate limit|secondary rate limit/i.test(stderr);
}

/** Transient gh CLI failures worth retrying (network blips, 5xx, DNS). */
const TRANSIENT_FAILURE =
  /network|timeout|timed out|connection|econnreset|enotfound|ehostunreach|temporar|try again|\b5\d{2}\b|bad gateway|service unavailable|gateway timeout/i;
/** gh's documented exit code for "authentication required" — needs user action, never retry. */
const GH_EXIT_AUTH_REQUIRED = 4;
function isTransientFailure(stderr: string, exitCode: number | null): boolean {
  // gh uses 1 for most errors; ≥2 is often a crash/infra failure — EXCEPT 4,
  // which `gh help exit-codes` documents as missing/expired credentials.
  // Retrying an auth failure would burn the retry ceiling on an error only
  // the operator can fix, so it is terminal.
  if (exitCode === GH_EXIT_AUTH_REQUIRED) return false;
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1) return true;
  return TRANSIENT_FAILURE.test(stderr);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readUpTo(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  // Parity with the engine's collectWithMaxBuffer: a straggler grandchild
  // holding an inherited pipe must not block collection past the kill timer.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
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
    signal?.removeEventListener('abort', onAbort);
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

type GhRunnerOpts = {
  workspacePath: string;
  args: readonly string[];
  timeoutMs?: number;
};

/**
 * The `gh` CLI transport the non-GraphQL helpers (fetchPrView & friends) call.
 * Indirected through this binding so tests can substitute a mock and exercise
 * the response-validation guards without spawning `gh` (mirroring the GraphQL
 * seam above).
 */
let ghRunner: (opts: GhRunnerOpts) => Promise<GithubResult<string>> = runGh;

/** Test seam: substitute (or restore) the `gh` CLI transport used by fetchPrView. */
export function setGhRunnerForTests(
  fn: ((opts: GhRunnerOpts) => Promise<GithubResult<string>>) | null
): void {
  ghRunner = fn ?? runGh;
}

async function runGh(opts: GhRunnerOpts): Promise<GithubResult<string>> {
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

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
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
      readUpTo(proc.stdout, MAX_OUTPUT_BYTES, controller.signal),
      readUpTo(proc.stderr, MAX_OUTPUT_BYTES, controller.signal),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort(); // release collectors if the process exited first
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
  host?: string,
  opts?: { timeoutMs?: number }
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
    timeoutMs: opts?.timeoutMs,
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
    // Classify retryability from the error MESSAGES only — stringifying the
    // whole errors array would let an unrelated "rate limit" substring
    // anywhere in the payload misclassify a terminal failure.
    const messages = errors
      .map((e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : ''))
      .join(' | ');
    const text = JSON.stringify(errors);
    const retryable = isRateLimit(messages) || TRANSIENT_FAILURE.test(messages);
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
  fn:
    | ((
        ctx: HookContext,
        query: string,
        host?: string,
        opts?: { timeoutMs?: number }
      ) => Promise<GithubResult<unknown>>)
    | null
): void {
  graphqlRunner = fn ?? runGhGraphqlImpl;
}

async function runGhGraphql(
  ctx: HookContext,
  query: string,
  host?: string,
  opts?: { timeoutMs?: number }
): Promise<GithubResult<unknown>> {
  return graphqlRunner(ctx, query, host, opts);
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
  const result = await ghRunner({
    workspacePath,
    args: ['pr', 'view', link, '--json', 'state,mergeable,mergeStateStatus'],
  });
  if (!result.ok) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.data);
  } catch {
    // Self-stamp the infra prefix (defense-in-depth, matching the structural
    // guard below): every terminal fetchPrView failure must be
    // override-ineligible at the hook layer regardless of caller.
    return {
      ok: false,
      retryable: false,
      error: `${GH_INFRA_ERROR_PREFIX}gh pr view returned non-JSON output`,
    };
  }
  // Structural validation: a successful exit with a malformed envelope must
  // NOT fabricate CLOSED/UNKNOWN fields — pr_ready/pr_merged would surface an
  // override-eligible policy stop off invented state. Treat it as a terminal
  // infrastructure failure instead.
  const view = parsePrView(parsed);
  const stateOk = view.state === 'OPEN' || view.state === 'CLOSED' || view.state === 'MERGED';
  const mergeableOk =
    view.mergeable === 'MERGEABLE' ||
    view.mergeable === 'CONFLICTING' ||
    view.mergeable === 'UNKNOWN';
  const raw = asRecord(parsed);
  // mergeStateStatus must be a PRESENT string too: parsePrView fabricates
  // 'UNKNOWN' for a missing value, and pr_ready maps UNKNOWN to a retryable
  // "GitHub still computing" — an envelope missing the field would queue an
  // otherwise valid handoff indefinitely instead of surfacing the malformed
  // lookup as an override-ineligible infrastructure failure.
  if (
    !stateOk ||
    !mergeableOk ||
    typeof raw?.state !== 'string' ||
    typeof raw?.mergeStateStatus !== 'string'
  ) {
    return {
      ok: false,
      retryable: false,
      error:
        GH_INFRA_ERROR_PREFIX +
        'gh pr view returned a structurally invalid response (missing/unknown state fields)',
    };
  }
  return { ok: true, data: view };
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
 * GitHub pagination cursors are base64 (`[A-Za-z0-9+/=]`). Validating the
 * charset before interpolating a cursor into a query is defense-in-depth: the
 * values come from GitHub's own pageInfo, but a malformed/hostile value must
 * not reach the GraphQL string.
 */
const CURSOR_RE = /^[A-Za-z0-9+/=]+$/;

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
  // ONE deadline across the whole logical lookup: each page otherwise gets a
  // fresh command timeout, so a many-page scan can hold one MCP action for
  // many multiples of it without the engine able to retry/back off.
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const urls: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        retryable: true,
        error: 'review-thread scan exceeded its overall deadline (fail closed)',
      };
    }
    const after = cursor ? `after:"${cursor}",` : '';
    const query =
      `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
      `reviewThreads(first: ${THREADS_PAGE_SIZE}, ${after}) { pageInfo { hasNextPage endCursor } ` +
      'nodes { isResolved comments(first: 1) { nodes { url } } } } } } }';
    const result = await runGhGraphql(ctx, query, pr.host, { timeoutMs: remaining });
    if (!result.ok) return result;
    // Structural fail-closed: a successful envelope whose reviewThreads
    // connection is missing `nodes` or `pageInfo` is a malformed/partial
    // response — treating it as a complete empty scan would let pr_ready
    // hand off with no evidence the conversations were checked.
    const prNode = asRecord(
      asRecord(asRecord(asRecord(result.data)?.data)?.repository)?.pullRequest
    );
    const threadsConnection = asRecord(prNode?.reviewThreads);
    if (!Array.isArray(threadsConnection?.nodes)) {
      return {
        ok: false,
        retryable: true,
        error: 'malformed reviewThreads connection (missing nodes); failing closed',
      };
    }
    const info = extractThreadsPageInfo(result.data);
    if (!info || info.hasNextPage === undefined) {
      return {
        ok: false,
        retryable: true,
        error:
          'malformed reviewThreads connection (missing/corrupt pageInfo.hasNextPage); failing closed',
      };
    }
    // Node-level fail-closed: a thread without a BOOLEAN isResolved (e.g. {}
    // or null) must not be skipped as though resolved — the extract loop
    // treats non-false as resolved, so a malformed node would silently pass
    // an unchecked conversation through pr_ready.
    for (const node of threadsConnection.nodes) {
      if (typeof asRecord(node)?.isResolved !== 'boolean') {
        return {
          ok: false,
          retryable: true,
          error: 'malformed review thread node (missing/non-boolean isResolved); failing closed',
        };
      }
    }
    urls.push(...extractUnresolvedThreads(result.data));
    if (info.hasNextPage !== true) return { ok: true, data: urls };
    if (typeof info.endCursor !== 'string' || !CURSOR_RE.test(info.endCursor)) break;
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
  // hasNextPage only when it is a real boolean: coercing a missing/corrupt
  // value to `false` would make the caller treat a partial page as a
  // complete scan.
  return {
    hasNextPage: typeof pageInfo.hasNextPage === 'boolean' ? pageInfo.hasNextPage : undefined,
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
    // An unresolved thread whose first comment URL is missing (deleted
    // comment, viewer-restricted) still COUNTS — a placeholder keeps the
    // gate blocked instead of silently passing it.
    urls.push(typeof firstUrl === 'string' ? firstUrl : '<unavailable thread url>');
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
  // Query the TAIL of both connections (`first:` returns the EARLIEST page,
  // so fresh evidence on a busy PR would fall outside it), then WALK the
  // reviews connection BACKWARDS (before-cursor) while its oldest entry is
  // still fresh: a qualifying formal review can sit under >50 newer COMMENTED
  // reviews, and on a non-own PR only formal evidence satisfies the gate.
  // Bounded page cap; exhausting it fails closed.
  const REVIEWS_PAGE = 50;
  const MAX_REVIEW_PAGES = 10;
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const allReviewNodes: unknown[] = [];
  let lastCommentsPage: unknown;
  let before: string | null = null;
  let reachedBoundary = false;
  for (let page = 0; page < MAX_REVIEW_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        retryable: true,
        error: 'review-evidence scan exceeded its overall deadline (fail closed)',
      };
    }
    const beforeClause = before ? `, before:"${before}"` : '';
    const query =
      `query { viewer { login } repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
      `author { login } reviews(last: ${REVIEWS_PAGE}${beforeClause}) { ` +
      'pageInfo { hasPreviousPage startCursor } nodes { state publishedAt } } ' +
      'comments(last: 50) { nodes { createdAt } } } } }';
    const result = await runGhGraphql(ctx, query, pr.host, { timeoutMs: remaining });
    if (!result.ok) return result;
    lastCommentsPage = result.data;
    const prNode = asRecord(
      asRecord(asRecord(asRecord(result.data)?.data)?.repository)?.pullRequest
    );
    const reviewsConnection = asRecord(prNode?.reviews);
    // Structural fail-closed (mirrors the other connections).
    const evidencePageInfo = asRecord(reviewsConnection?.pageInfo);
    if (
      !Array.isArray(reviewsConnection?.nodes) ||
      !evidencePageInfo ||
      typeof evidencePageInfo.hasPreviousPage !== 'boolean'
    ) {
      return {
        ok: false,
        retryable: true,
        error: 'malformed reviews connection (missing nodes/pageInfo); failing closed',
      };
    }
    const nodes = reviewsConnection?.nodes;
    if (Array.isArray(nodes)) allReviewNodes.unshift(...nodes);
    const pageInfo = asRecord(reviewsConnection?.pageInfo);
    // Stop when the page reaches past the run-start window: everything older
    // cannot contribute fresh evidence. Compare EPOCHS, not lexical strings:
    // GitHub timestamps can carry fractional seconds while `sinceIso` is
    // whole-second precision, and lexically '...00.500Z' sorts BEFORE
    // '...00Z' — the actually-newer review would read as older and stop
    // pagination early, dropping qualifying evidence on an earlier page (the
    // evidence predicate and reaction boundary below already compare epochs).
    // A NULL publishedAt (pending/draft review) proves nothing about the
    // boundary — keep paging (the page cap fails closed if the window
    // extends beyond it).
    const oldest = Array.isArray(nodes) && nodes.length > 0 ? asRecord(nodes[0]) : undefined;
    const oldestAt = typeof oldest?.publishedAt === 'string' ? oldest.publishedAt : '';
    const oldestMs = oldestAt ? Date.parse(oldestAt) : NaN;
    const sinceMs = Date.parse(sinceIso);
    if (
      !pageInfo?.hasPreviousPage ||
      (oldestAt !== '' &&
        Number.isFinite(oldestMs) &&
        Number.isFinite(sinceMs) &&
        oldestMs < sinceMs)
    ) {
      reachedBoundary = true;
      break;
    }
    const startCursor = pageInfo.startCursor;
    if (typeof startCursor !== 'string' || !CURSOR_RE.test(startCursor)) break;
    before = startCursor;
  }
  if (!reachedBoundary) {
    // Cap exhausted while still inside the fresh window — the scan cannot
    // prove absence/presence of formal evidence; fail closed.
    return {
      ok: false,
      retryable: true,
      error:
        `PR has more than ${MAX_REVIEW_PAGES * REVIEWS_PAGE} reviews since the run started; ` +
        'unable to scan the full evidence window (fail closed).',
    };
  }
  // Rebuild the envelope with the merged review history (object spread of a
  // possibly-undefined value is a no-op, so no fallbacks are needed).
  const lastRecord = lastCommentsPage as Record<string, unknown> | undefined;
  const lastData = asRecord(lastRecord?.data);
  const lastRepository = asRecord(lastData?.repository);
  const lastPullRequest = asRecord(lastRepository?.pullRequest);
  const merged = {
    ...lastRecord,
    data: {
      ...lastData,
      repository: {
        ...lastRepository,
        pullRequest: {
          ...lastPullRequest,
          reviews: { nodes: allReviewNodes },
        },
      },
    },
  };
  return { ok: true, data: extractReviewEvidence(merged, sinceIso) };
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
  /** The head SHA the verdict was computed against (for the final recheck). */
  evaluatedHeadOid?: string;
}

/**
 * The codex review-bot's login slugs. The bot surfaces as a `Bot`
 * `chatgpt-codex-connector` on review comments, as a `User`
 * `chatgpt-codex-connector[bot]` on reactions, and as the `codex[bot]`
 * variant named by the built-in workflow guidance. Match EXACTLY the
 * documented forms (not on `__typename`, which differs between them) so all
 * count, while a human whose login merely contains a slug (e.g.
 * `chatgpt-codex-connector-x`) does not.
 */
const CODEX_BOT_LOGINS = new Set([
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
  'codex[bot]',
]);

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
  // ONE deadline across the whole codex lookup (reviews + reactions + final
  // head check): each request otherwise gets a fresh command timeout.
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const remainingBudget = () => deadline - Date.now();
  const deadlineError = () => ({
    ok: false as const,
    retryable: true,
    error: 'codex approval scan exceeded its overall deadline (fail closed)',
  });

  const headQuery = (after: string | null) =>
    `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
    `reviews(first: ${CODEX_REVIEWS_PAGE_SIZE}${after ? `, after:"${after}"` : ''}) { ` +
    'pageInfo { hasNextPage endCursor } ' +
    'nodes { state author { login } commit { oid } body submittedAt } } ' +
    // Reaction connection: walked BACKWARD from the tail while the oldest
    // entry is still newer than the head push (bounded cap, fail-closed) —
    // `first:` returns the earliest page, and a fixed tail can omit the codex
    // +1 under >50 newer reactions.
    'reactions(last: 50, content: THUMBS_UP) { pageInfo { hasPreviousPage startCursor } ' +
    'nodes { createdAt user { login } } } ' +
    'commits(last: 1) { nodes { commit { oid pushedDate } } } } } }';

  const allReviewNodes: unknown[] = [];
  const allReactionNodes: unknown[] = [];
  let lastPage: Record<string, unknown> | undefined;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_CODEX_REVIEW_PAGES; page++) {
    const remaining = remainingBudget();
    if (remaining <= 0) return deadlineError();
    const result = await runGhGraphql(ctx, headQuery(cursor), pr.host, {
      timeoutMs: remaining,
    });
    if (!result.ok) return result;
    lastPage = asRecord(result.data) ?? {};
    const prNode = asRecord(asRecord(asRecord(lastPage.data)?.repository)?.pullRequest);
    const reviewsConnection = asRecord(prNode?.reviews);
    // Structural fail-closed: a malformed reviews connection (missing nodes
    // or pageInfo) must not be treated as a complete scan — an omitted
    // decisive CHANGES_REQUESTED could otherwise approve via the reaction path.
    const codexPageInfo = asRecord(reviewsConnection?.pageInfo);
    if (
      !Array.isArray(reviewsConnection?.nodes) ||
      !codexPageInfo ||
      typeof codexPageInfo.hasNextPage !== 'boolean'
    ) {
      return {
        ok: false,
        retryable: true,
        error: 'malformed reviews connection (missing nodes/pageInfo); failing closed',
      };
    }
    const nodes = reviewsConnection?.nodes;
    if (Array.isArray(nodes)) allReviewNodes.push(...nodes);
    // `nodes` is a GraphQL connection ARRAY — index it directly (asRecord
    // rejects arrays, which would silently drop the initial tail page).
    const reactionNodes = asRecord(prNode?.reactions)?.nodes;
    if (Array.isArray(reactionNodes)) allReactionNodes.unshift(...reactionNodes);
    let reactionPageInfo: Record<string, unknown> | undefined = asRecord(
      asRecord(prNode?.reactions)?.pageInfo
    );
    const pageInfo = asRecord(reviewsConnection?.pageInfo);
    if (pageInfo?.hasNextPage !== true) {
      // Definitive end of the review history — evaluate the merged document.
      // Walk the reactions connection backward while its oldest entry is
      // still newer than the head push: a valid codex +1 can sit under >50
      // newer thumbs. Bounded cap; exhaustion fails closed.
      let reactionsComplete = false;
      for (let page = 0; page < MAX_CODEX_REVIEW_PAGES; page++) {
        if (reactionPageInfo?.hasPreviousPage !== true) {
          reactionsComplete = true;
          break;
        }
        const startCursor = reactionPageInfo.startCursor;
        if (typeof startCursor !== 'string' || !CURSOR_RE.test(startCursor)) break;
        // Re-query with a before-cursor on the reactions connection only.
        const q =
          `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
          `reactions(last: 50, content: THUMBS_UP, before:"${startCursor}") { ` +
          'pageInfo { hasPreviousPage startCursor } nodes { createdAt user { login } } } ' +
          'commits(last: 1) { nodes { commit { oid pushedDate } } } } } }';
        const remainingR = remainingBudget();
        if (remainingR <= 0) return deadlineError();
        const result = await runGhGraphql(ctx, q, pr.host, { timeoutMs: remainingR });
        if (!result.ok) return result;
        const rNode = asRecord(
          asRecord(asRecord(asRecord(result.data)?.data)?.repository)?.pullRequest
        );
        const rConn = asRecord(rNode?.reactions);
        if (!Array.isArray(rConn?.nodes) || !asRecord(rConn?.pageInfo)) {
          return {
            ok: false,
            retryable: true,
            error: 'malformed reactions connection (missing nodes/pageInfo); failing closed',
          };
        }
        const rNodes = rConn?.nodes;
        if (Array.isArray(rNodes)) allReactionNodes.unshift(...rNodes);
        reactionPageInfo = asRecord(rConn?.pageInfo);
        // Stop once the page reaches the head-push boundary (epoch compare —
        // lexical ISO strings mis-order fractional vs whole seconds).
        const oldestR =
          Array.isArray(rNodes) && rNodes.length > 0 ? asRecord(rNodes[0]) : undefined;
        const oldestRAt = typeof oldestR?.createdAt === 'string' ? oldestR.createdAt : '';
        const commitNodes = asRecord(rNode?.commits)?.nodes;
        const pushed = Array.isArray(commitNodes)
          ? asRecord(asRecord(commitNodes[0])?.commit)?.pushedDate
          : undefined;
        const oldestRMs = oldestRAt ? Date.parse(oldestRAt) : NaN;
        const pushedMs = typeof pushed === 'string' ? Date.parse(pushed) : NaN;
        if (!Number.isFinite(oldestRMs) || !Number.isFinite(pushedMs) || oldestRMs <= pushedMs) {
          reactionsComplete = true;
          break;
        }
      }
      if (!reactionsComplete) {
        return {
          ok: false,
          retryable: true,
          error:
            `PR has more than ${MAX_CODEX_REVIEW_PAGES * CODEX_REVIEWS_PAGE_SIZE} fresh reactions; ` +
            'unable to scan the full reaction window (fail closed).',
        };
      }
      const approval = extractCodexApproval(
        {
          data: {
            repository: {
              pullRequest: {
                ...prNode,
                reviews: { nodes: allReviewNodes },
                reactions: { nodes: allReactionNodes },
              },
            },
          },
        },
        link
      );
      if (!approval.approved) return { ok: true, data: approval };
      // FINAL HEAD RECHECK: the multi-page scan takes time, and a commit
      // pushed after the last page was received would leave this approval
      // computed against a stale head — opening the gate for an unreviewed
      // head. Re-resolve the head now and retry (fail-closed) if it moved.
      const remainingHead = remainingBudget();
      if (remainingHead <= 0) return deadlineError();
      const headCheck = await runGhGraphql(
        ctx,
        `query { repository(owner:"${pr.owner}",name:"${pr.repo}") { pullRequest(number:${pr.number}) { ` +
          'commits(last: 1) { nodes { commit { oid } } } } } }',
        pr.host,
        { timeoutMs: remainingHead }
      );
      if (!headCheck.ok) return headCheck;
      const headCheckPr = asRecord(
        asRecord(asRecord(asRecord(headCheck.data)?.data)?.repository)?.pullRequest
      );
      const headCheckNodes = asRecord(headCheckPr?.commits)?.nodes;
      const currentOid = Array.isArray(headCheckNodes)
        ? asRecord(asRecord(headCheckNodes[headCheckNodes.length - 1])?.commit)?.oid
        : undefined;
      if (
        typeof currentOid !== 'string' ||
        typeof approval.evaluatedHeadOid !== 'string' ||
        currentOid !== approval.evaluatedHeadOid
      ) {
        return {
          ok: false,
          retryable: true,
          error:
            'PR head changed while the codex approval was being evaluated; re-evaluating ' +
            '(fail closed against the stale-head approval).',
        };
      }
      return { ok: true, data: approval };
    }
    if (typeof pageInfo?.endCursor !== 'string' || !CURSOR_RE.test(pageInfo.endCursor)) break;
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
    let latest: { submittedMs: number; state: string } | null = null;
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
      // Compare EPOCHS, not lexical strings: GitHub timestamps can carry
      // fractional seconds, and lexically '...00.500Z' sorts BEFORE
      // '...00Z' — an earlier same-second APPROVED would beat a later
      // fractional CHANGES_REQUESTED and false-pass the gate. `>=` keeps
      // connection order as the tie-breaker for TRUE timestamp ties: two
      // decisive reviews at the same instant are ordered by their position
      // in the (chronological, pagination-merged) connection.
      const submittedMs = Date.parse(submittedAt);
      if (Number.isFinite(submittedMs)) {
        if (!latest || submittedMs >= latest.submittedMs) {
          latest = { submittedMs, state };
        }
      } else if (!latest) {
        // Unparseable timestamp: keep it only as a floor candidate so a
        // later well-formed review can still supersede it.
        latest = { submittedMs: -Infinity, state };
      }
    }
    if (latest) return { approved: latest.state === 'APPROVED', prLink, evaluatedHeadOid: headOid };
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
        return { approved: true, prLink, evaluatedHeadOid: headOid };
      }
    }
  }

  return { approved: false, prLink };
}
