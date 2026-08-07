/**
 * get_pr_diff handler — fetches a GitHub PR diff server-side (authed, no shell).
 *
 * The Reviewer needs authed access to a PR's unified diff. Once it runs without
 * a shell (Option C role separation) it cannot run `gh pr diff` itself, and the
 * shell-free alternatives are not authed for private repos:
 *   - WebFetch(`<pr_url>.diff`) is unauthenticated → fails for private repos.
 *   - Read/Grep/Glob see only the worktree head-state; they cannot compute a
 *     diff vs the base branch or list which files changed.
 *
 * This handler is the direct analog of {@link post_review} for *reading* a PR:
 * it calls the GitHub API via the daemon's `gh` credentials — the same auth path
 * `post_review`, the github connector, and the `pr_ready` validator use
 * (`runGhJson` / `buildGitHubLookupEnv`) — so private repos work.
 *
 * It returns structured per-file data (filename, status, additions, deletions,
 * patch, and the previous filename for renames) plus PR metadata (base/head shas
 * + refs, mergeability, additions / deletions totals). Each file's `patch` is
 * that file's unified diff hunk — richer than raw `gh pr diff` output and
 * aligned with what a reviewer needs.
 *
 * Host restriction: `prUrl` is LLM-controlled (a reviewer tool arg), so before
 * spawning `gh` the orchestrator confines the host to `github.com` or the
 * configured Enterprise host ({@link isAllowedGhHost}). This prevents a
 * prompt-injected `prUrl` from sending the daemon's credentialled request to an
 * attacker-controlled host (SSRF / token disclosure).
 *
 * The orchestration logic (URL parse + host check + pagination + shape mapping)
 * is a pure function of injected deps so it is unit-testable without spawning
 * `gh`. The real `gh` wiring lives in {@link buildGhGetPrDiffDeps}.
 */

import type { ParsedPrUrl } from '../runtime/parse-pr-url';
import { parsePrUrl } from '../runtime/parse-pr-url';
import { runGhJson } from '../runtime/gh-lookup-helpers';

/** Arguments passed to {@link getPrDiff}. */
export interface GetPrDiffArgs {
  prUrl: string;
}

/** One changed file in the diff. */
export interface PrDiffFile {
  filename: string;
  /** GitHub file status: added | modified | removed | renamed | copied | changed | unchanged. */
  status: string;
  additions: number;
  deletions: number;
  /**
   * Unified diff hunk for this file. Absent for binary files or patches GitHub
   * itself truncated (very large diffs) — read the full file via Read/Grep/Glob
   * when a patch is missing.
   */
  patch?: string;
  /** Previous path for `renamed` / `copied` files; absent otherwise. */
  previousFilename?: string;
}

/** PR-level metadata returned alongside the changed files. */
export interface PrDiffMeta {
  url: string;
  title: string;
  state: string;
  draft: boolean;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  /** null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/**
 * A `gh` failure surfaced through the deps. `retryable` / `retryAfterMs` mirror
 * `runGhJson`'s rate-limit classification so the caller knows when a retry is
 * safe (this is a multi-request, authed tool — rate limits are likely).
 */
export interface GetPrDiffDepsError {
  error: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** Result of fetching a PR diff. */
export interface GetPrDiffResult {
  success: boolean;
  pr?: PrDiffMeta;
  files?: PrDiffFile[];
  /** True when the PR exceeds the file cap (some files were omitted). */
  truncated?: boolean;
  /**
   * Count of files GitHub returned without a `patch` (binary or oversized diffs
   * it truncates). The caller can't reconstruct those changes from the head
   * worktree alone (removed files / base-side lines), so a non-zero value means
   * the diff is incomplete and the review should flag the gap rather than treat
   * the fetch as complete.
   */
  filesWithoutPatch?: number;
  /** Present on failure — rate-limit guidance mirrored from `runGhJson`. */
  retryable?: boolean;
  retryAfterMs?: number;
  error?: string;
}

/**
 * Raw GitHub `GET /repos/{o}/{r}/pulls/{n}` shape — only the fields we read.
 * Exported so unit tests can construct fixtures for {@link mapPrMeta}.
 */
export interface RawPrMeta {
  html_url?: unknown;
  title?: unknown;
  state?: unknown;
  draft?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changed_files?: unknown;
  base?: { sha?: unknown; ref?: unknown };
  head?: { sha?: unknown; ref?: unknown };
}

/**
 * Raw GitHub `GET /repos/{o}/{r}/pulls/{n}/files` item shape — only the fields
 * we read. Exported so unit tests can construct fixtures for {@link mapPrFile}.
 */
export interface RawPrFile {
  filename?: unknown;
  status?: unknown;
  additions?: unknown;
  deletions?: unknown;
  patch?: unknown;
  /** GitHub sets this only for `renamed` / `copied` files. */
  previous_filename?: unknown;
}

/**
 * The `gh api` operations + host config the orchestrator needs, abstracted for
 * testability. Production wiring: {@link buildGhGetPrDiffDeps}. Tests pass fakes.
 */
export interface GetPrDiffDeps {
  /**
   * Configured GitHub Enterprise host (process.env.GH_HOST in production), in
   * addition to `github.com`, that the daemon may send credentialled requests
   * to. Used by {@link isAllowedGhHost}.
   */
  enterpriseHost?: string;
  /** Fetch PR-level metadata (`/pulls/{n}`). */
  fetchPrMeta(
    meta: ParsedPrUrl
  ): Promise<{ ok: true; data: RawPrMeta } | ({ ok: false } & GetPrDiffDepsError)>;
  /** Fetch one page of changed files (`/pulls/{n}/files?page=N&per_page=100`). */
  fetchPrFilesPage(
    meta: ParsedPrUrl,
    page: number
  ): Promise<{ ok: true; data: RawPrFile[] } | ({ ok: false } & GetPrDiffDepsError)>;
}

/** Page size for the files endpoint. */
const FILES_PER_PAGE = 100;
/** Hard cap on files fetched (GitHub's own ceiling on `/pulls/{n}/files`). */
const MAX_FILES = 3000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Whether `host` is a GitHub host the daemon may send authenticated `gh`
 * requests to. Confined to `github.com` and the configured Enterprise host so a
 * prompt-injected `prUrl` cannot redirect the daemon's credentialled request to
 * an attacker-controlled host (SSRF / token disclosure via the Authorization
 * header on Enterprise-token installs). Pure for unit testing.
 */
export function isAllowedGhHost(host: string, enterpriseHost?: string): boolean {
  const h = host.toLowerCase();
  if (h === 'github.com') return true;
  const enterprise = enterpriseHost?.trim().toLowerCase();
  return enterprise !== undefined && enterprise.length > 0 && h === enterprise;
}

/**
 * Whether two GitHub PR URLs identify the same PR (normalized host/owner/repo/
 * number, case-insensitive). Used by the wiring to bind a caller-supplied
 * `prUrl` to the workflow run's recorded PR so a prompt-injected reviewer can't
 * point `get_pr_diff` at a different (e.g. other private) repo on an allowed
 * host and exfiltrate it through the daemon's credentials. Mirrors the cross-PR
 * guard in `merge-pr-handler`. Returns false when either URL is unparseable.
 */
export function isSamePrIdentity(urlA: string, urlB: string): boolean {
  const a = parsePrUrl(urlA);
  const b = parsePrUrl(urlB);
  return (
    !!a &&
    !!b &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.number === b.number
  );
}

/** Map a raw `/pulls/{n}` object to the clean {@link PrDiffMeta} shape. */
export function mapPrMeta(raw: RawPrMeta, fallbackUrl: string): PrDiffMeta {
  return {
    url: asString(raw.html_url) || fallbackUrl,
    title: asString(raw.title),
    state: asString(raw.state),
    draft: asBoolOrNull(raw.draft) ?? false,
    base: { sha: asString(raw.base?.sha), ref: asString(raw.base?.ref) },
    head: { sha: asString(raw.head?.sha), ref: asString(raw.head?.ref) },
    mergeable: asBoolOrNull(raw.mergeable),
    mergeableState: asString(raw.mergeable_state) || null,
    additions: asNumber(raw.additions),
    deletions: asNumber(raw.deletions),
    changedFiles: asNumber(raw.changed_files),
  };
}

/** Map a raw `/pulls/{n}/files` item to the clean {@link PrDiffFile} shape. */
export function mapPrFile(raw: RawPrFile): PrDiffFile {
  const file: PrDiffFile = {
    filename: asString(raw.filename),
    status: asString(raw.status),
    additions: asNumber(raw.additions),
    deletions: asNumber(raw.deletions),
  };
  // GitHub omits `patch` for binary files and for diffs it truncates. Only
  // surface it when present and non-empty so callers can trust its presence.
  if (typeof raw.patch === 'string' && raw.patch.length > 0) {
    file.patch = raw.patch;
  }
  // `previous_filename` is present only for renames / copies — surface it so a
  // shell-free reviewer can tell what path moved without a separate gh call.
  if (typeof raw.previous_filename === 'string' && raw.previous_filename.length > 0) {
    file.previousFilename = raw.previous_filename;
  }
  return file;
}

/**
 * Fetch a PR diff: PR metadata + every changed file with its patch.
 *
 * Resolution order:
 *   1. parsePrUrl — fail fast on a malformed URL before spawning anything.
 *   2. isAllowedGhHost — confine the host before any credentialled request.
 *   3. fetchPrMeta — PR-level metadata (base/head shas, mergeability, totals).
 *   4. Paginate fetchPrFilesPage until a short/empty page (last page) or the
 *      MAX_FILES cap; `truncated` is set only when files were actually omitted.
 *
 * Any gh failure (meta or a files page) short-circuits with the gh error string
 * — and, for rate limits, the `retryable` / `retryAfterMs` guidance so the
 * caller (Reviewer) retries at the right time instead of hammering the limit.
 */
export async function getPrDiff(
  args: GetPrDiffArgs,
  deps: GetPrDiffDeps
): Promise<GetPrDiffResult> {
  const meta = parsePrUrl(args.prUrl);
  if (!meta) {
    return { success: false, error: `Unable to parse GitHub PR URL: ${args.prUrl}` };
  }

  if (!isAllowedGhHost(meta.host, deps.enterpriseHost)) {
    return {
      success: false,
      error:
        `Refusing get_pr_diff for host '${meta.host}': only github.com and the configured ` +
        `GitHub Enterprise host are allowed (protects the daemon's gh credentials from SSRF).`,
    };
  }

  const metaOutcome = await deps.fetchPrMeta(meta);
  if (!metaOutcome.ok) {
    return {
      success: false,
      error: metaOutcome.error,
      retryable: metaOutcome.retryable,
      retryAfterMs: metaOutcome.retryAfterMs,
    };
  }

  const files: PrDiffFile[] = [];
  const maxPages = Math.ceil(MAX_FILES / FILES_PER_PAGE);
  for (let page = 1; page <= maxPages; page++) {
    const outcome = await deps.fetchPrFilesPage(meta, page);
    if (!outcome.ok) {
      return {
        success: false,
        error: outcome.error,
        retryable: outcome.retryable,
        retryAfterMs: outcome.retryAfterMs,
      };
    }
    const pageFiles = Array.isArray(outcome.data) ? outcome.data : [];
    for (const raw of pageFiles) {
      files.push(mapPrFile(raw));
    }
    if (files.length >= MAX_FILES) {
      break;
    }
    // A short page is the last one (GitHub returns [] for pages past the end).
    if (pageFiles.length < FILES_PER_PAGE) {
      break;
    }
  }

  const pr = mapPrMeta(metaOutcome.data, args.prUrl);
  // `truncated` means files were actually omitted. Distinguish "PR has more files
  // than the cap" from "PR changed exactly MAX_FILES files" using the metadata's
  // changed_files; fall back to conservative true when changed_files is unknown.
  const truncated =
    files.length >= MAX_FILES && (pr.changedFiles === 0 || pr.changedFiles > files.length);

  return {
    success: true,
    pr,
    files,
    truncated,
    filesWithoutPatch: files.filter((f) => f.patch === undefined).length,
  };
}

/** Default per-command timeout for a `gh api` GET. */
const DEFAULT_GET_PR_DIFF_TIMEOUT_MS = 30_000;

/**
 * Build the production {@link GetPrDiffDeps} backed by the `gh` CLI (authed —
 * `runGhJson` forwards the daemon's GitHub credential env via
 * `buildGitHubLookupEnv`, the same path as `post_review` / the github connector).
 *
 * `fetchPrMeta` calls `GET /repos/{o}/{r}/pulls/{n}`; `fetchPrFilesPage` calls
 * `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100&page={page}`. Both forward
 * the PR's host via `--hostname` (and `hostHint`) so GitHub Enterprise hosts
 * route the rate-limit reset probe correctly, and both mirror `runGhJson`'s
 * rate-limit classification (`retryable` / `retryAfterMs`) on failure.
 *
 * Buffer bound: `runGhJson` caps stdout at 1 MiB (`MAX_BUFFER_BYTES`), shared
 * with the rest of the daemon. A pathologically patch-heavy files page could
 * exceed that and surface as a non-JSON error (the tool fails safe — no silent
 * truncation); the proper fix (a larger/adaptive buffer) lives in `runGhJson`.
 */
export function buildGhGetPrDiffDeps(deps: {
  spawnImpl: typeof Bun.spawn;
  cwd: string;
  timeoutMs?: number;
}): GetPrDiffDeps {
  const { spawnImpl, cwd, timeoutMs = DEFAULT_GET_PR_DIFF_TIMEOUT_MS } = deps;

  return {
    enterpriseHost: process.env.GH_HOST,

    async fetchPrMeta(meta) {
      const outcome = await runGhJson(
        [
          'gh',
          'api',
          '--hostname',
          meta.host,
          `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}`,
        ],
        cwd,
        spawnImpl,
        { timeoutMs, hostHint: meta.host }
      );
      if (!outcome.ok) {
        return {
          ok: false,
          error: outcome.error,
          retryable: outcome.retryable,
          retryAfterMs: outcome.retryAfterMs,
        };
      }
      const data = outcome.data;
      return data && typeof data === 'object' && !Array.isArray(data)
        ? { ok: true, data: data as RawPrMeta }
        : { ok: false, error: 'gh produced an unexpected PR metadata response' };
    },

    async fetchPrFilesPage(meta, page) {
      const outcome = await runGhJson(
        [
          'gh',
          'api',
          '--hostname',
          meta.host,
          `repos/${meta.owner}/${meta.repo}/pulls/${meta.number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        ],
        cwd,
        spawnImpl,
        { timeoutMs, hostHint: meta.host }
      );
      if (!outcome.ok) {
        return {
          ok: false,
          error: outcome.error,
          retryable: outcome.retryable,
          retryAfterMs: outcome.retryAfterMs,
        };
      }
      return Array.isArray(outcome.data)
        ? { ok: true, data: outcome.data as RawPrFile[] }
        : { ok: false, error: 'gh produced an unexpected PR files response' };
    },
  };
}
