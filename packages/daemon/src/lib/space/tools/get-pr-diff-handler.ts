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
 * patch) plus PR metadata (base/head shas + refs, mergeability, additions /
 * deletions totals). Each file's `patch` is that file's unified diff hunk —
 * richer than raw `gh pr diff` output and aligned with what a reviewer needs.
 *
 * The orchestration logic (URL parse + pagination + shape mapping) is a pure
 * function of injected deps so it is unit-testable without spawning `gh`. The
 * real `gh` wiring lives in {@link buildGhGetPrDiffDeps}.
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

/** Result of fetching a PR diff. */
export interface GetPrDiffResult {
  success: boolean;
  pr?: PrDiffMeta;
  files?: PrDiffFile[];
  /** True when the PR exceeds the file cap (some files were omitted). */
  truncated?: boolean;
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
}

/**
 * The two `gh api` operations the orchestrator needs, abstracted for
 * testability. Production wiring: {@link buildGhGetPrDiffDeps}. Tests pass fakes.
 */
export interface GetPrDiffDeps {
  /** Fetch PR-level metadata (`/pulls/{n}`). */
  fetchPrMeta(
    meta: ParsedPrUrl
  ): Promise<{ ok: true; data: RawPrMeta } | { ok: false; error: string }>;
  /** Fetch one page of changed files (`/pulls/{n}/files?page=N&per_page=100`). */
  fetchPrFilesPage(
    meta: ParsedPrUrl,
    page: number
  ): Promise<{ ok: true; data: RawPrFile[] } | { ok: false; error: string }>;
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
  return file;
}

/**
 * Fetch a PR diff: PR metadata + every changed file with its patch.
 *
 * Resolution order:
 *   1. parsePrUrl — fail fast on a malformed URL before spawning anything.
 *   2. fetchPrMeta — PR-level metadata (base/head shas, mergeability, totals).
 *   3. Paginate fetchPrFilesPage until a short/empty page (last page) or the
 *      MAX_FILES cap; set `truncated` when the cap is hit.
 *
 * Any gh failure (meta or a files page) short-circuits with the gh error string
 * — the caller (Reviewer) can read it and retry.
 */
export async function getPrDiff(
  args: GetPrDiffArgs,
  deps: GetPrDiffDeps
): Promise<GetPrDiffResult> {
  const meta = parsePrUrl(args.prUrl);
  if (!meta) {
    return { success: false, error: `Unable to parse GitHub PR URL: ${args.prUrl}` };
  }

  const metaOutcome = await deps.fetchPrMeta(meta);
  if (!metaOutcome.ok) {
    return { success: false, error: metaOutcome.error };
  }

  const files: PrDiffFile[] = [];
  let truncated = false;
  const maxPages = Math.ceil(MAX_FILES / FILES_PER_PAGE);
  for (let page = 1; page <= maxPages; page++) {
    const outcome = await deps.fetchPrFilesPage(meta, page);
    if (!outcome.ok) {
      return { success: false, error: outcome.error };
    }
    const pageFiles = Array.isArray(outcome.data) ? outcome.data : [];
    for (const raw of pageFiles) {
      files.push(mapPrFile(raw));
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    // A short page is the last one (GitHub returns [] for pages past the end).
    if (pageFiles.length < FILES_PER_PAGE) {
      break;
    }
  }

  return {
    success: true,
    pr: mapPrMeta(metaOutcome.data, args.prUrl),
    files,
    truncated,
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
 * route the rate-limit reset probe correctly.
 */
export function buildGhGetPrDiffDeps(deps: {
  spawnImpl: typeof Bun.spawn;
  cwd: string;
  timeoutMs?: number;
}): GetPrDiffDeps {
  const { spawnImpl, cwd, timeoutMs = DEFAULT_GET_PR_DIFF_TIMEOUT_MS } = deps;

  return {
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
      if (!outcome.ok) return { ok: false, error: outcome.error };
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
      if (!outcome.ok) return { ok: false, error: outcome.error };
      return Array.isArray(outcome.data)
        ? { ok: true, data: outcome.data as RawPrFile[] }
        : { ok: false, error: 'gh produced an unexpected PR files response' };
    },
  };
}
