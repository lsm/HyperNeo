import { useCallback, useEffect, useState } from 'preact/hooks';
import { spaceStore, type QueueAgeStats, type QueueHealthSnapshot } from '../../lib/space-store.ts';
import { Button } from '../ui/Button.tsx';

function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} m`;
}

function formatRelative(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ageStats(stats: QueueAgeStats | null): string {
  if (!stats) return '—';
  return `p95 ${formatAge(stats.p95Ms)} · max ${formatAge(stats.maxMs)} · ${stats.count} item${stats.count === 1 ? '' : 's'}`;
}

function entryList(record: Record<string, number>): Array<{ key: string; value: number }> {
  return Object.entries(record)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): preact.JSX.Element {
  return (
    <div class="rounded-lg border border-line-strong bg-surface-overlay px-3 py-2">
      <div class="text-[11px] uppercase tracking-wide text-fg-faint">{label}</div>
      <div class="mt-0.5 text-sm font-medium text-fg">{value}</div>
      {hint ? <div class="mt-0.5 text-[11px] text-fg-faint">{hint}</div> : null}
    </div>
  );
}

function Breakdown({
  title,
  entries,
  emptyHint,
}: {
  title: string;
  entries: Array<{ key: string; value: number }>;
  emptyHint: string;
}): preact.JSX.Element {
  return (
    <div>
      <div class="text-[11px] uppercase tracking-wide text-fg-faint">{title}</div>
      {entries.length === 0 ? (
        <div class="mt-1 text-xs text-fg-faint">{emptyHint}</div>
      ) : (
        <ul class="mt-1 space-y-0.5 text-xs text-fg-soft">
          {entries.map((entry) => (
            <li key={entry.key} class="flex items-center justify-between gap-2">
              <span class="truncate font-mono text-[11px] text-fg-muted" title={entry.key}>
                {entry.key}
              </span>
              <span class="tabular-nums text-fg-soft">{entry.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QueueHealthSummary(): preact.JSX.Element {
  const [snapshot, setSnapshot] = useState<QueueHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await spaceStore.getExternalEventQueueHealth();
      setSnapshot(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counters = snapshot?.counters;
  const gauges = snapshot?.gauges;
  const totalFailures = counters
    ? Object.values(counters.finalFailuresByReason).reduce((sum, value) => sum + value, 0)
    : 0;
  const settled = counters ? counters.delivered + totalFailures : 0;
  const successRate =
    settled > 0 && counters ? Math.round((counters.delivered / settled) * 100) : null;

  return (
    <div
      class="rounded-lg border border-line bg-surface-raised px-3 py-3"
      data-testid="queue-health-summary"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-fg-soft">Queue health</div>
          <p class="mt-0.5 text-xs text-fg-muted">
            Daemon-wide pending external-event delivery queue.{' '}
            {snapshot ? `Counting since ${formatRelative(snapshot.counters.since)}` : ''}
            {snapshot ? ` · updated ${formatRelative(snapshot.collectedAt)}.` : ''}
          </p>
        </div>
        <Button type="button" size="sm" loading={loading} onClick={refresh}>
          Refresh
        </Button>
      </div>

      {error ? (
        <div class="mt-3 rounded-lg border border-red-900/60 bg-danger/40 px-3 py-2 text-xs text-danger-soft">
          Failed to load queue health: {error}
        </div>
      ) : null}

      {!snapshot && !error ? (
        <div class="mt-3 text-xs text-fg-faint">
          {loading ? 'Loading…' : 'No data yet. Click Refresh.'}
        </div>
      ) : null}

      {snapshot && counters && gauges ? (
        <div class="mt-3 space-y-3">
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Metric
              label="Queue depth"
              value={`${gauges.queueDepth}`}
              hint={`${gauges.queueKeys} target queue${gauges.queueKeys === 1 ? '' : 's'} · ${gauges.persistedPending} persisted`}
            />
            <Metric
              label="In flight"
              value={`${gauges.inFlight}`}
              hint={`${gauges.retryTimers} retry timer${gauges.retryTimers === 1 ? '' : 's'}`}
            />
            <Metric
              label="Queue age"
              value={gauges.queueDepth > 0 ? formatAge(gauges.queueAgeMs?.p95Ms ?? 0) : '—'}
              hint={ageStats(gauges.queueAgeMs)}
            />
            <Metric
              label="Enqueued"
              value={`${counters.enqueue}`}
              hint={`${counters.flushAttempts} flush attempt${counters.flushAttempts === 1 ? '' : 's'}`}
            />
            <Metric
              label="Delivered"
              value={`${counters.delivered}`}
              hint={successRate === null ? undefined : `${successRate}% of settled`}
            />
            <Metric label="Failed (terminal)" value={`${totalFailures}`} />
            <Metric
              label="Skips"
              value={`${
                counters.claimConflicts +
                counters.staleSessionSkips +
                counters.pausedSpaceSkips +
                counters.cooldownSkips
              }`}
              hint={`${counters.claimConflicts} claim · ${counters.staleSessionSkips} stale-session · ${counters.pausedSpaceSkips} paused · ${counters.cooldownSkips} cooldown`}
            />
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Breakdown
              title="Failures by category"
              entries={entryList(snapshot.failuresByCategory)}
              emptyHint="No terminal failures."
            />
            <Breakdown
              title="Enqueued by source"
              entries={entryList(counters.enqueueBySource)}
              emptyHint="No enqueues recorded."
            />
            <Breakdown
              title="Enqueued by target state"
              entries={entryList(counters.enqueueByTargetState)}
              emptyHint="No enqueues recorded."
            />
            <Breakdown
              title="Failures by reason"
              entries={entryList(counters.finalFailuresByReason)}
              emptyHint="No terminal failures."
            />
          </div>

          <div class="text-[11px] text-fg-faint">
            Persisted pending age: {ageStats(gauges.persistedAgeMs)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
