/**
 * Git helpers for workflow-run artifact operations.
 *
 * This module centralises the async git subprocess wrapper and parsers used
 * by both the `spaceWorkflowRun.*` RPC handlers and the background job
 * handler that populates `workflow_run_artifact_cache`. Keeping the logic in
 * one place means a fix (e.g. a bumped timeout or a parser tweak) applies to
 * both the synchronous and the async code paths.
 *
 * Merge-base caching: `getDiffBaseRef()` used to probe up to three candidate
 * refs sequentially — with a 5 s timeout each — on every panel open. The
 * result is now memoised in-process per worktree path with a short TTL so
 * repeated calls inside the same session resolve instantly.
 */

import { execFile } from 'node:child_process';

/** Default timeout for git subprocess calls (30 s). */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Merge-base cache TTL — 60 s as per the design brief. */
export const MERGE_BASE_TTL_MS = 60_000;

export interface FileDiffStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  files: FileDiffStat[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: number;
  additions: number;
  deletions: number;
  fileCount: number;
}

/**
 * Async wrapper around `execFile('git', ...)`. Non-blocking — does not stall
 * the event loop while git is running.
 */
export function execGit(
  args: string[],
  cwd: string,
  timeout = DEFAULT_GIT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `maxBuffer` default is 1 MB which is easily exceeded by large diffs; bump
    // to 64 MB so a big `git diff` doesn't truncate the output (truncation
    // would be interpreted as an error by the parent promise).
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as string);
      }
    );
  });
}

/** Returns true when `worktreePath` is inside a git repository. */
export async function isGitRepo(worktreePath: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--git-dir'], worktreePath, 5_000);
    return true;
  } catch {
    return false;
  }
}

interface MergeBaseCacheEntry {
  base: string;
  expiresAt: number;
}

const mergeBaseCache = new Map<string, MergeBaseCacheEntry>();

/**
 * Get the diff base ref for a worktree, memoised per-path for `MERGE_BASE_TTL_MS`.
 *
 * Tries `origin/dev`, `origin/main`, `origin/master` in order and returns the
 * first merge-base that succeeds. Falls back to an empty string (meaning
 * "uncommitted changes only") when none of the candidates are available.
 */
export async function getDiffBaseRef(
  worktreePath: string,
  options?: { now?: number; ttlMs?: number }
): Promise<string> {
  const now = options?.now ?? Date.now();
  const ttl = options?.ttlMs ?? MERGE_BASE_TTL_MS;
  const cached = mergeBaseCache.get(worktreePath);
  if (cached && cached.expiresAt > now) {
    return cached.base;
  }

  let base = '';
  for (const candidate of ['origin/dev', 'origin/main', 'origin/master']) {
    try {
      const result = await execGit(['merge-base', 'HEAD', candidate], worktreePath, 5_000);
      if (result.trim()) {
        base = result.trim();
        break;
      }
    } catch {
      // candidate not available — try the next one
    }
  }

  mergeBaseCache.set(worktreePath, { base, expiresAt: now + ttl });
  return base;
}

/** Drop a cached merge-base entry so the next call re-probes the worktree. */
export function invalidateDiffBaseRef(worktreePath?: string): void {
  if (worktreePath === undefined) {
    mergeBaseCache.clear();
  } else {
    mergeBaseCache.delete(worktreePath);
  }
}

/** Exported for tests — returns the size of the in-memory merge-base cache. */
export function mergeBaseCacheSize(): number {
  return mergeBaseCache.size;
}

/**
 * Parse `git diff --numstat` output into structured file stats.
 * Each line is `<additions>\t<deletions>\t<path>`. Binary files show
 * `-\t-\t<path>` and are recorded with 0/0 stats.
 */
export function parseNumstat(output: string): DiffSummary {
  const files: FileDiffStat[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const additions = parseInt(parts[0], 10) || 0;
    const deletions = parseInt(parts[1], 10) || 0;
    const path = parts.slice(2).join('\t');
    files.push({ path, additions, deletions });
    totalAdditions += additions;
    totalDeletions += deletions;
  }

  return { files, totalAdditions, totalDeletions };
}

/**
 * Field delimiter used inside the `COMMIT:` header line produced by
 * `git log --format`. We use the ASCII Unit Separator (`\x1F`) rather than
 * `|` so commit subjects (`%s`) that legitimately contain pipe characters
 * (e.g. `fix: handle | in input`) don't shift the author/timestamp fields.
 */
export const COMMIT_LOG_FIELD_DELIMITER = '\x1F';

/**
 * `git log --format` string used by both the sync RPC handler and the
 * background job handler. Keeping it in one place means the parser and the
 * producer always agree on the delimiter.
 */
export const COMMIT_LOG_FORMAT = `--format=COMMIT:%H${COMMIT_LOG_FIELD_DELIMITER}%s${COMMIT_LOG_FIELD_DELIMITER}%aN${COMMIT_LOG_FIELD_DELIMITER}%at`;

/**
 * Parse `git log --format=COMMIT:%H\x1F%s\x1F%aN\x1F%at --numstat` output.
 * Each commit block starts with a `COMMIT:` line followed by numstat lines.
 */
export function parseCommitLog(output: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  let current: CommitInfo | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      if (current) commits.push(current);
      const parts = line.slice('COMMIT:'.length).split(COMMIT_LOG_FIELD_DELIMITER);
      current = {
        sha: parts[0]?.trim() ?? '',
        message: parts[1]?.trim() ?? '',
        author: parts[2]?.trim() ?? '',
        timestamp: parseInt(parts[3]?.trim() ?? '0', 10) * 1000,
        additions: 0,
        deletions: 0,
        fileCount: 0,
      };
    } else if (current && line.trim()) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        current.additions += parseInt(parts[0], 10) || 0;
        current.deletions += parseInt(parts[1], 10) || 0;
        current.fileCount += 1;
      }
    }
  }
  if (current) commits.push(current);
  return commits;
}

/** Count +/- lines in a unified diff (ignoring the `+++`/`---` header rows). */
export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

// ─── Cache key helpers ────────────────────────────────────────────────────────
//
// These helpers produce the deterministic `cache_key` string used in
// `workflow_run_artifact_cache` so every callsite (RPC handler, job handler,
// LiveQuery reader on the frontend) agrees on the shape.

export const CACHE_KEY_GATE_ARTIFACTS = 'gateArtifacts';
export const CACHE_KEY_COMMITS = 'commits';

export function fileDiffCacheKey(filePath: string): string {
  return `fileDiff:${filePath}`;
}

export function commitFilesCacheKey(commitSha: string): string {
  return `commitFiles:${commitSha}`;
}

export function commitFileDiffCacheKey(commitSha: string, filePath: string): string {
  return `commitFileDiff:${commitSha}:${filePath}`;
}

/** Size cap (in bytes) for full diff payloads served from the cache. */
export const FILE_DIFF_SIZE_LIMIT_BYTES = 100 * 1024;

/**
 * Returns the push URL for the `origin` remote, or `null` when git is
 * unavailable, the path is not a repo, or no origin remote is configured.
 */
export async function getGitRemoteUrl(worktreePath: string): Promise<string | null> {
  try {
    const url = await execGit(['remote', 'get-url', 'origin'], worktreePath, 5_000);
    return url.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Converts a git remote URL (SSH or HTTPS) for a GitHub repo into a clean
 * `https://github.com/{owner}/{repo}` URL.
 *
 * Returns `null` when the remote is not a GitHub URL.
 *
 * Examples:
 *   `git@github.com:owner/repo.git`       → `https://github.com/owner/repo`
 *   `https://github.com/owner/repo.git`   → `https://github.com/owner/repo`
 *   `https://github.com/owner/repo`       → `https://github.com/owner/repo`
 */
export function normalizeGithubUrl(remoteUrl: string): string | null {
  // SSH format: git@github.com:owner/repo.git or git@github.com:owner/repo
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^.]+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;

  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^.]+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;

  return null;
}
