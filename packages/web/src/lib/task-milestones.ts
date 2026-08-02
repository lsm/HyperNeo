import type { TaskMilestoneRow } from '@hyperneo/shared';

/**
 * Maximum gap (ms) between two retries that still counts as the same burst.
 * SDK retries fire within seconds; anything further apart is a separate episode
 * (or a different worker) and must not be merged into one fabricated count.
 */
const RETRY_BURST_MS = 5 * 60_000;

/** Internal working row carrying a retry-burst counter during curation. */
interface WorkingRow extends TaskMilestoneRow {
  retryCount?: number;
}

/**
 * Two milestones are "the same" (one is an echo of the other) only when every
 * display field matches, including the producer. Without the source, two
 * different agents returning the same short answer (e.g. "Done") would collapse
 * the second legitimate response.
 */
function sameMilestone(a: TaskMilestoneRow, b: TaskMilestoneRow): boolean {
  return (
    a.category === b.category &&
    a.title === b.title &&
    (a.body ?? '') === (b.body ?? '') &&
    (a.sourceLabel ?? '') === (b.sourceLabel ?? '')
  );
}

/**
 * Collapse consecutive duplicate / retry milestones into single entries.
 *
 * - Consecutive `retry` rows fold into a single row whose title reports the
 *   attempt count and whose body is the last attempt's detail — but only when
 *   they belong to the same burst (within `RETRY_BURST_MS`). Retries farther
 *   apart are kept separate so the count is never fabricated.
 * - Consecutive identical milestones from the same producer (same category +
 *   title + body + source — e.g. an echoed agent answer) are dropped.
 *
 * Input must be sorted ascending by `createdAt` (the LiveQuery guarantee).
 * Returns a fresh array; input rows are not mutated.
 */
export function curateTaskMilestones(rows: TaskMilestoneRow[]): TaskMilestoneRow[] {
  const out: WorkingRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (
      last &&
      last.category === 'retry' &&
      row.category === 'retry' &&
      // Scope a burst to one producer (the owning agent) so retries from
      // different workers in a multi-agent run are never folded together.
      (last.sourceLabel ?? '') === (row.sourceLabel ?? '')
    ) {
      if (row.createdAt - last.createdAt <= RETRY_BURST_MS) {
        // Same burst: fold into the running row.
        const count = (last.retryCount ?? 1) + 1;
        last.retryCount = count;
        last.title = `API retried ${count}×`;
        last.body = row.body ?? last.body;
        last.createdAt = row.createdAt;
        continue;
      }
      // Far apart: a separate episode — keep it (never dedupe retries).
      out.push({ ...row, retryCount: 1 });
      continue;
    }
    if (last && sameMilestone(last, row)) {
      continue;
    }
    out.push({ ...row, retryCount: row.category === 'retry' ? 1 : undefined });
  }
  // The retry count is folded into the title; drop the internal flag.
  return out.map(({ retryCount: _ignored, ...rest }) => rest);
}

/**
 * Compact relative timestamp ("just now", "5m", "3h", "2d", then M/D). `now` is
 * passed in so the helper stays pure and testable; the component supplies
 * `Date.now()` at render time.
 */
export function formatRelativeTimestamp(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  const hr = 3_600_000;
  const day = 86_400_000;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hr)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return new Date(ts).toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}
