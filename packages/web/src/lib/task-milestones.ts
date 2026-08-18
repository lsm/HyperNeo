import type { TaskMilestoneRow } from '@hyperneo/shared';

const RETRY_BURST_MS = 5 * 60_000;

const ECHO_WINDOW_MS = 60_000;

interface WorkingRow extends TaskMilestoneRow {
  retryCount?: number;
}

function sameMilestone(a: TaskMilestoneRow, b: TaskMilestoneRow): boolean {
  return (
    a.category === b.category &&
    a.title === b.title &&
    (a.body ?? '') === (b.body ?? '') &&
    a.tone === b.tone &&
    (a.sourceLabel ?? '') === (b.sourceLabel ?? '')
  );
}

export function curateTaskMilestones(rows: TaskMilestoneRow[]): TaskMilestoneRow[] {
  const out: WorkingRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.category === 'retry' && row.category === 'retry') {
      const sameSource =
        (last.sourceId ?? last.sourceLabel ?? '') === (row.sourceId ?? row.sourceLabel ?? '');
      if (sameSource && row.createdAt - last.createdAt <= RETRY_BURST_MS) {
        const count = (last.retryCount ?? 1) + 1;
        last.retryCount = count;
        last.title = `API retried ${count}×`;
        last.body = row.body ?? last.body;
        last.createdAt = row.createdAt;
        continue;
      }
      out.push({ ...row, retryCount: 1 });
      continue;
    }
    if (last && sameMilestone(last, row) && row.createdAt - last.createdAt <= ECHO_WINDOW_MS) {
      continue;
    }
    out.push({ ...row, retryCount: row.category === 'retry' ? 1 : undefined });
  }
  return out.map(({ retryCount: _ignored, ...rest }) => rest);
}

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
