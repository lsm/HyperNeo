/**
 * Shared worktree path utilities.
 *
 * Provides standalone functions for resolving worktree base directories
 * under `~/.hyperneo/projects/`. Used by both `WorktreeManager` (room sessions)
 * and `SpaceWorktreeManager` (space task agents).
 */

import { getDataDir } from './data-dir';
import { hashString32 } from './runtime-hash';
import { basename, join, normalize } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Encode an absolute path to a filesystem-safe directory name.
 *
 * Uses the same approach as Claude Code (~/.claude/projects/).
 *
 * Examples:
 * - /Users/alice/project → -Users-alice-project
 * - /home/john_doe/my_project → -home-john_doe-my_project
 */
export function encodeRepoPath(repoPath: string): string {
  const normalizedPath = repoPath.replace(/\\/g, '/');

  const encoded = normalizedPath.startsWith('/')
    ? '-' + normalizedPath.slice(1).replace(/\//g, '-')
    : '-' + normalizedPath.replace(/\//g, '-');

  return encoded;
}

/**
 * Produce a short, deterministic, human-readable directory name for a repo path.
 *
 * Format: `{sanitized-basename}-{8-char-hex-hash}`
 * Example: `dev-neokai-a3b2c1d4`
 *
 * The 8-char hex hash is derived from the lower 32 bits of `Bun.hash()` applied
 * to the full normalized path, using BigInt arithmetic to avoid truncation above
 * 2^53 that `Number(bigint).toString(16)` would silently produce.
 */
export function getProjectShortKey(repoPath: string): string {
  const normalizedPath = normalize(repoPath).replace(/\\/g, '/');
  const lastComponent = basename(normalizedPath);
  const sanitized = lastComponent.replace(/[^a-zA-Z0-9_-]/g, '-') || 'project';
  const hash8 = hashString32(normalizedPath).toString(16).padStart(8, '0');
  return `${sanitized}-${hash8}`;
}

/**
 * Resolve the worktree base directory for a git repository.
 *
 * Uses a short human-readable key (`{basename}-{hash8}`) instead of the full
 * encoded path, with a `.hyperneo-repo-root` sentinel file for collision detection.
 *
 * Returns the directory where worktree subdirectories should be created, e.g.:
 *   `~/.hyperneo/projects/{shortKey}/worktrees`
 *
 * Collision handling:
 * - First use   → create `~/.hyperneo/projects/{shortKey}/` and write sentinel.
 * - Same repo   → sentinel matches; proceed normally.
 * - Collision   → sentinel belongs to a different repo; fall back to `encodeRepoPath`.
 * - No sentinel → dir was created by an older HyperNeo version; write sentinel and proceed.
 *
 * For testing, set TEST_WORKTREE_BASE_DIR to override the `~/.hyperneo` prefix.
 *
 * @param gitRoot  - Absolute path to the git repository root
 * @param onCollision - Optional callback invoked when a hash collision is detected
 */
export function getWorktreeBaseDir(
  gitRoot: string,
  onCollision?: (message: string) => void
): string {
  const normalizedGitRoot = normalize(gitRoot).replace(/\\/g, '/');
  const shortKey = getProjectShortKey(normalizedGitRoot);

  const testBaseDir = process.env.TEST_WORKTREE_BASE_DIR;
  const projectDir = testBaseDir
    ? join(testBaseDir, shortKey)
    : join(getDataDir(), 'projects', shortKey);

  const sentinelFile = join(projectDir, '.hyperneo-repo-root');

  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(sentinelFile, normalizedGitRoot);
  } else if (existsSync(sentinelFile)) {
    const storedPath = readFileSync(sentinelFile, 'utf-8').trim();
    if (storedPath !== normalizedGitRoot) {
      const msg = `Short key collision detected for "${shortKey}": expected "${storedPath}", got "${normalizedGitRoot}". Falling back to full encoding.`;
      onCollision?.(msg);

      const encodedPath = encodeRepoPath(normalizedGitRoot);
      const fallbackProjectDir = testBaseDir
        ? join(testBaseDir, encodedPath)
        : join(getDataDir(), 'projects', encodedPath);
      return join(fallbackProjectDir, 'worktrees');
    }
  } else {
    writeFileSync(sentinelFile, normalizedGitRoot);
  }

  return join(projectDir, 'worktrees');
}
