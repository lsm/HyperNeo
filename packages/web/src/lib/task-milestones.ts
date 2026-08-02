import type { TaskMilestoneRow } from '@hyperneo/shared';

/** Internal working row carrying a retry-burst counter during curation. */
interface WorkingRow extends TaskMilestoneRow {
  retryCount?: number;
}

function sameMilestone(a: TaskMilestoneRow, b: TaskMilestoneRow): boolean {
  return a.category === b.category && a.title === b.title && (a.body ?? '') === (b.body ?? '');
}

/**
 * Collapse consecutive duplicate / retry milestones into single entries.
 *
 * - Consecutive `retry` rows (one API-retry burst) fold into a single row whose
 *   title reports the attempt count and whose body is the last attempt's detail.
 * - Consecutive identical milestones (same category + title + body — e.g. an
 *   echoed agent answer) are dropped.
 *
 * Input must be sorted ascending by `createdAt` (the LiveQuery guarantee).
 * Returns a fresh array; input rows are not mutated.
 */
export function curateTaskMilestones(rows: TaskMilestoneRow[]): TaskMilestoneRow[] {
  const out: WorkingRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.category === 'retry' && row.category === 'retry') {
      const count = (last.retryCount ?? 1) + 1;
      last.retryCount = count;
      last.title = `API retried ${count}×`;
      last.body = row.body ?? last.body;
      last.createdAt = row.createdAt;
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
