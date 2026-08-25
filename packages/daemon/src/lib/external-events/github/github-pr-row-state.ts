import { parseGitHubTimestamp } from './github-normalizer.ts';

export function pullRequestUpdatedAt(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  return parseGitHubTimestamp((row as { updated_at?: unknown }).updated_at);
}

export function isPullRequestOpen(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const state = (row as { state?: unknown }).state;
  return state === 'open';
}
