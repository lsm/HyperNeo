/**
 * GitHub reaction row fields — pure helpers that read typed fields off a raw
 * GitHub reaction row (`unknown`): whether it represents a positive (`+1` /
 * `thumbs_up`) reaction, and its numeric id as a string. Safe fallbacks for
 * missing/malformed rows.
 *
 * Canonical home. These helpers previously lived inline near the bottom of
 * {@link file://./github-event-extension.ts} (the reaction polling handler);
 * that file now imports them from here.
 *
 * Narrow capability surface: {@link isPositiveReaction} and
 * {@link reactionIdFrom}. No module-private members. Both are independent
 * leaves with no internal or external edges.
 */

/**
 * Returns true only when the reaction row's `content` is `'+1'` or
 * `'thumbs_up'` — the positive reactions the polling handler publishes as
 * `reaction_added`. A missing/malformed row, or any other content (`-1`,
 * `laugh`, `heart`, …), is treated as not-positive so the handler skips it.
 */
export function isPositiveReaction(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const content = (row as { content?: unknown }).content;
  return content === '+1' || content === 'thumbs_up';
}

/**
 * Reads the reaction row's `id` as a string — the durable key the polling
 * handler stores in its `seenReactionIds` index to dedupe reactions across
 * cycles. Returns `''` for a missing/malformed row or any row whose `id` is
 * not a number.
 */
export function reactionIdFrom(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const id = (row as { id?: unknown }).id;
  return typeof id === 'number' ? String(id) : '';
}
