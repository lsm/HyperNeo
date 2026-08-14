/**
 * GitHub pull-request head-ref identity — pure helpers that resolve the
 * identity of a pull request's head ref (the repo path it lives in and the
 * commit SHA it points at), a stable `repoPath@sha` key for dedup / comparison
 * across polls, and a query that selects all open PRs whose head points at a
 * given SHA.
 *
 * Canonical home. These helpers previously lived inline at the bottom of
 * {@link file://./github-event-extension.ts} (the pull-request polling and
 * deployment-webhook handlers); that file now imports them from here.
 *
 * Narrow capability surface: {@link gitHubRepoPath}, {@link pullRequestNumberFrom},
 * {@link headShaFromPullRequest}, {@link headRepoFromPullRequest},
 * {@link headRefKey}, {@link parseHeadRefKey}, and {@link pickPrNumbersByHeadSha}.
 * No module-private members. The internal edges are
 * {@link headRepoFromPullRequest} → {@link gitHubRepoPath} and
 * {@link pickPrNumbersByHeadSha} → {@link headShaFromPullRequest}; the rest are
 * independent leaves.
 */

import type { GitHubWatchedRepo } from './github-repository';

/**
 * Encodes a GitHub repo identity as the `owner/repo` path segment used across
 * API URLs, subscription topics, and head-ref keys. Both segments are
 * URL-encoded so owners/repos with special characters round-trip safely.
 */
export function gitHubRepoPath(owner: string, repo: string): string {
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** Reads `number` off a `/pulls` row; returns `0` (falsy) when absent/unreadable. */
export function pullRequestNumberFrom(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const number = (row as { number?: unknown }).number;
  return typeof number === 'number' ? number : 0;
}

/** Reads `head.sha` from a `/pulls` row (the commit the PR HEAD points at). */
export function headShaFromPullRequest(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const head = (row as { head?: unknown }).head;
  if (!head || typeof head !== 'object') return '';
  const sha = (head as { sha?: unknown }).sha;
  return typeof sha === 'string' ? sha : '';
}

/**
 * Resolves the repo path a PR's head lives in, falling back to the watched
 * repo's path at every missing/malformed step (`row`, `row.head`,
 * `row.head.repo`, `row.head.repo.owner.login` / `row.head.repo.name`). A fork
 * PR therefore resolves to its head-fork path; a same-repo PR or any
 * degenerate row resolves to the watched repo's path.
 */
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

/** Composes the durable head-ref identity key `repoPath@headSha`. */
export function headRefKey(repoPath: string, headSha: string): string {
  return `${repoPath}@${headSha}`;
}

/**
 * Inverse of {@link headRefKey}: splits on the LAST `@` (so a repo path that
 * itself contains `@` still round-trips, as long as the SHA does not). When
 * there is no usable separator (`separator > 0` is false — no `@`, or a
 * leading `@` at index 0), `repoPath` is `''` and the whole key is returned
 * as `headSha`.
 */
export function parseHeadRefKey(key: string): { repoPath: string; headSha: string } {
  const separator = key.lastIndexOf('@');
  return {
    repoPath: separator > 0 ? key.slice(0, separator) : '',
    headSha: separator > 0 ? key.slice(separator + 1) : key,
  };
}

/**
 * Returns the numbers of all OPEN PRs whose HEAD (`head.sha`) is exactly `sha`
 * — every open match is published, because a commit can be the head of several
 * PRs at once. The head.sha filter excludes PRs that merely contain the commit
 * (e.g. the merged PR that introduced a default-branch tip), so a default-branch
 * or stale-SHA deploy resolves to nothing and drops; the `state === 'open'`
 * filter additionally excludes a closed/merged PR whose retained head.sha still
 * equals the deployed SHA, so a deploy never publishes under a finished PR's
 * topic and wakes a stale subscription. Dedupes by PR number. Mirrors the
 * filter in `resolvePullRequestNumbersForCommit` (status webhook).
 */
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
