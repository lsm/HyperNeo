import type { GitHubWatchedRepo } from './github-repository';

export function gitHubRepoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export function pullRequestNumberFrom(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const number = (row as { number?: unknown }).number;
  return typeof number === 'number' ? number : 0;
}

export function headShaFromPullRequest(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const head = (row as { head?: unknown }).head;
  if (!head || typeof head !== 'object') return '';
  const sha = (head as { sha?: unknown }).sha;
  return typeof sha === 'string' ? sha : '';
}

export function headRepoFromPullRequest(row: unknown, watched: GitHubWatchedRepo): string {
  if (!row || typeof row !== 'object') return gitHubRepoPath(watched.owner, watched.repo);
  const head = (row as { head?: unknown }).head;
  if (!head || typeof head !== 'object') return gitHubRepoPath(watched.owner, watched.repo);
  const repo = (head as { repo?: unknown }).repo;
  if (!repo || typeof repo !== 'object') return gitHubRepoPath(watched.owner, watched.repo);
  const owner = (repo as { owner?: unknown }).owner;
  const ownerLogin = owner && typeof owner === 'object' ? (owner as { login?: unknown }).login : '';
  const repoName = (repo as { name?: unknown }).name;
  if (typeof ownerLogin === 'string' && typeof repoName === 'string' && ownerLogin && repoName) {
    return gitHubRepoPath(ownerLogin, repoName);
  }
  return gitHubRepoPath(watched.owner, watched.repo);
}

export function headRefKey(repoPath: string, headSha: string): string {
  return `${repoPath}@${headSha}`;
}

export function parseHeadRefKey(key: string): { repoPath: string; headSha: string } {
  const separator = key.lastIndexOf('@');
  return {
    repoPath: separator > 0 ? key.slice(0, separator) : '',
    headSha: separator > 0 ? key.slice(separator + 1) : key,
  };
}

export function pickPrNumbersByHeadSha(pulls: unknown, sha: string): number[] {
  if (!Array.isArray(pulls)) return [];
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const entry of pulls) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (headShaFromPullRequest(row) !== sha) continue;
    if (row.state !== 'open') continue;
    const number = typeof row.number === 'number' ? row.number : 0;
    if (number > 0 && !seen.has(number)) {
      seen.add(number);
      numbers.push(number);
    }
  }
  return numbers;
}
