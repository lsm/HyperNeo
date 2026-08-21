import { execFile } from 'node:child_process';

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

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

export function execGit(
  args: string[],
  cwd: string,
  timeout = DEFAULT_GIT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
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
    } catch {}
  }

  mergeBaseCache.set(worktreePath, { base, expiresAt: now + ttl });
  return base;
}

export function invalidateDiffBaseRef(worktreePath?: string): void {
  if (worktreePath === undefined) {
    mergeBaseCache.clear();
  } else {
    mergeBaseCache.delete(worktreePath);
  }
}

export function mergeBaseCacheSize(): number {
  return mergeBaseCache.size;
}

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

export const COMMIT_LOG_FIELD_DELIMITER = '\x1F';

export const COMMIT_LOG_FORMAT = `--format=COMMIT:%H${COMMIT_LOG_FIELD_DELIMITER}%s${COMMIT_LOG_FIELD_DELIMITER}%aN${COMMIT_LOG_FIELD_DELIMITER}%at`;

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

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

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

export const FILE_DIFF_SIZE_LIMIT_BYTES = 100 * 1024;

export async function getGitRemoteUrl(worktreePath: string): Promise<string | null> {
  try {
    const url = await execGit(['remote', 'get-url', 'origin'], worktreePath, 5_000);
    return url.trim() || null;
  } catch {
    return null;
  }
}

export function normalizeGithubUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^.]+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;

  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^.]+?)(?:\.git)?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;

  return null;
}
