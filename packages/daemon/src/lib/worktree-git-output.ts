/**
 * Pure decoders for `git` machine-readable output.
 *
 * Extracts the deterministic text → domain parsing that `WorktreeManager`'s
 * review/status pipeline depends on:
 *  - `gitStatusKind`: map porcelain XY status codes to a typed status.
 *  - `parsePorcelainStatus`: parse `git status --porcelain=v1 -z` into changed files.
 *  - `normalizeNumstatPath`: collapse `git diff --numstat` rename syntax.
 *  - `parseNumstatMap`: parse `git diff --numstat` lines into per-path counts.
 *
 * These are pure functions with no I/O; `WorktreeManager` remains the imperative
 * shell that runs the git commands and feeds their output here.
 */
import type { GitChangedFile, GitFileStatusKind } from '@hyperneo/shared';

/**
 * Map a pair of porcelain status column codes (staged + unstaged) to a typed
 * status. Mirrors git's `--porcelain=v1` semantics: conflicted states win over
 * everything, then untracked, then rename; otherwise the more interesting of
 * the two columns decides.
 */
export function gitStatusKind(stagedCode: string, unstagedCode: string): GitFileStatusKind {
  if (
    stagedCode === 'U' ||
    unstagedCode === 'U' ||
    (stagedCode === 'A' && unstagedCode === 'A') ||
    (stagedCode === 'D' && unstagedCode === 'D')
  ) {
    return 'conflicted';
  }
  if (stagedCode === '?' || unstagedCode === '?') return 'untracked';
  if (stagedCode === 'R' || unstagedCode === 'R') return 'renamed';

  const code = unstagedCode !== ' ' ? unstagedCode : stagedCode;
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
      return 'modified';
    default:
      return 'other';
  }
}

/**
 * Parse `git status --porcelain=v1 -z` output into changed files.
 *
 * Each NUL-separated entry begins with a two-byte status field followed by a
 * space and the path; rename/copy entries carry a trailing NUL-separated
 * `<old>\0<new>` pair. Ignored entries (`!!`) are dropped. Files are sorted by
 * path to match the historical review-panel ordering.
 */
export function parsePorcelainStatus(output: string): GitChangedFile[] {
  const entries = output.split('\0').filter(Boolean);
  const files: GitChangedFile[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;

    const stagedCode = entry[0];
    const unstagedCode = entry[1];
    if (stagedCode === '!' && unstagedCode === '!') continue;

    const isRename = stagedCode === 'R' || unstagedCode === 'R';
    const isCopy = stagedCode === 'C' || unstagedCode === 'C';
    const path = entry.slice(3);
    const oldPath = isRename || isCopy ? entries[++i] : undefined;

    files.push({
      path,
      oldPath,
      status: gitStatusKind(stagedCode, unstagedCode),
      staged: stagedCode !== ' ' && stagedCode !== '?' && stagedCode !== '!',
      // Working-tree column — not the inverse of `staged`: an `MM` file has
      // both true. Untracked (`?`) counts as unstaged (working-tree only).
      unstaged: unstagedCode !== ' ' && unstagedCode !== '!',
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Per-file addition/deletion counts reported by `git diff --numstat`. */
export type NumstatEntry = { additions: number; deletions: number };

/**
 * Collapse the rename syntax `git diff --numstat` emits for moved files
 * (`a => b`, brace forms like `{old => new}`) down to the destination path.
 */
export function normalizeNumstatPath(path: string): string {
  if (!path.includes(' => ')) return path;

  const braceRename = path.match(/^(.*)\{(.+) => (.+)\}(.*)$/);
  if (braceRename) {
    return `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  }

  return path.slice(path.lastIndexOf(' => ') + 4);
}

/**
 * Parse `git diff --numstat` output into a path-keyed map of add/delete counts.
 * Binary files are reported with `-` for counts and resolve to 0/0. Lines
 * without a path column (blank trailing lines) are skipped.
 */
export function parseNumstatMap(output: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [additionsRaw, deletionsRaw, path] = line.split('\t');
    if (!path) continue;
    stats.set(normalizeNumstatPath(path), {
      additions: Number.parseInt(additionsRaw, 10) || 0,
      deletions: Number.parseInt(deletionsRaw, 10) || 0,
    });
  }
  return stats;
}
