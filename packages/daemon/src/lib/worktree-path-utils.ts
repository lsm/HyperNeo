import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import { getDataDir } from './data-dir.ts';
import { hashString32 } from './runtime-hash.ts';

export function encodeRepoPath(repoPath: string): string {
  const normalizedPath = repoPath.replace(/\\/g, '/');

  const encoded = normalizedPath.startsWith('/')
    ? '-' + normalizedPath.slice(1).replace(/\//g, '-')
    : '-' + normalizedPath.replace(/\//g, '-');

  return encoded;
}

export function getProjectShortKey(repoPath: string): string {
  const normalizedPath = normalize(repoPath).replace(/\\/g, '/');
  const lastComponent = basename(normalizedPath);
  const sanitized = lastComponent.replace(/[^a-zA-Z0-9_-]/g, '-') || 'project';
  const hash8 = hashString32(normalizedPath).toString(16).padStart(8, '0');
  return `${sanitized}-${hash8}`;
}

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
    const storedPath = readFileSync(sentinelFile, 'utf-8');
    if (storedPath !== normalizedGitRoot) {
      const msg = `Short key collision detected for "${shortKey}": expected "${storedPath}", got "${normalizedGitRoot}". Falling back to full encoding.`;
      onCollision?.(msg);

      const encodedPath = encodeRepoPath(normalizedGitRoot);
      const fallbackProjectDir = testBaseDir
        ? join(testBaseDir, encodedPath)
        : join(getDataDir(), 'projects', encodedPath);
      const fallbackSentinel = join(fallbackProjectDir, '.hyperneo-repo-root');
      if (existsSync(fallbackProjectDir)) {
        if (!existsSync(fallbackSentinel)) {
          writeFileSync(fallbackSentinel, normalizedGitRoot);
        }
      } else {
        mkdirSync(fallbackProjectDir, { recursive: true });
        writeFileSync(fallbackSentinel, normalizedGitRoot);
      }
      return join(fallbackProjectDir, 'worktrees');
    }
  } else {
    writeFileSync(sentinelFile, normalizedGitRoot);
  }

  return join(projectDir, 'worktrees');
}
