/**
 * GitHub pull-request row state — pure helpers that read the lifecycle state of
 * a raw GitHub `/pulls` row (`unknown`): when it was last updated, and whether
 * it is open. Safe fallbacks for missing/malformed rows.
 *
 * Canonical home. These helpers previously lived inline near the bottom of
 * {@link file://./github-event-extension.ts} (the pull-request polling handler);
 * that file now imports them from here.
 *
 * Narrow capability surface: {@link pullRequestUpdatedAt} and
 * {@link isPullRequestOpen}. No module-private members. The only internal edge
 * is {@link pullRequestUpdatedAt} → `parseGitHubTimestamp` (from
 * `github-normalizer`); {@link isPullRequestOpen} is an independent leaf.
 */

import { parseGitHubTimestamp } from './github-normalizer';

/**
 * Reads `updated_at` off a `/pulls` row as an epoch-millis timestamp. Returns
 * `0` (falsy) only for a missing/malformed row, so the polling handler can treat
 * `0` as "no usable watermark" and fall back to a seed fetch. For an object row
 * whose `updated_at` is absent or unparseable, delegates to
 * `parseGitHubTimestamp`, which returns the current time (`Date.now()`) — so a
 * real but timestamp-less row is treated as fresh rather than dropped.
 */
export function pullRequestUpdatedAt(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  return parseGitHubTimestamp((row as { updated_at?: unknown }).updated_at);
}

/**
 * Returns true only when the row's `state` is literally `'open'`. A
 * missing/malformed row — or any other state (`closed`, `merged`, …) — is
 * treated as not-open, so the polling handler drops it from the active set.
 */
export function isPullRequestOpen(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const state = (row as { state?: unknown }).state;
  return state === 'open';
}
