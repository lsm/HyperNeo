import type {
  EvolutionScope,
  MetricSnapshot,
  EvolutionMetricSnapshotListResponse,
  MetricSnapshotValues,
  EvolutionMetricSnapshotCreateResponse,
} from '@hyperneo/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import type { SnapshotValueDraft } from './space-forge-values.ts';
import { parseMetricValue, formatDate } from './space-forge-values.ts';
import { toast } from '../../lib/toast';
import { FORM_CONTROL_CLASS } from '../ui/FormField';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

export function MetricsTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [snapshots, setSnapshots] = useState<MetricSnapshot[]>([]);
  const [values, setValues] = useState<SnapshotValueDraft[]>(
    scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' }))
  );
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadSnapshots = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<EvolutionMetricSnapshotListResponse>(
        'evolution.metricSnapshot.list',
        {
          scopeId: scope.id,
        }
      );
      if (requestVersion.current === version) setSnapshots(response.snapshots ?? []);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load metric snapshots');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    setValues(scope.metricDefinitions.map((metric) => ({ key: metric.key, value: '' })));
    loadSnapshots().catch(() => undefined);
  }, [loadSnapshots, scope.metricDefinitions]);

  const updateValue = (index: number, value: string) => {
    setValues((current) =>
      current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, value } : entry))
    );
  };

  const handleAddSnapshot = async (event: Event) => {
    event.preventDefault();
    const snapshotValues = values.reduce<MetricSnapshotValues>((acc, entry) => {
      if (entry.value.trim()) acc[entry.key] = parseMetricValue(entry.value);
      return acc;
    }, {});
    if (Object.keys(snapshotValues).length === 0) {
      setError('At least one metric value is required');
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      await request<EvolutionMetricSnapshotCreateResponse>('evolution.metricSnapshot.create', {
        params: {
          scopeId: scope.id,
          values: snapshotValues,
          source: 'manual',
          note: note.trim() || null,
        },
      });
      setValues((current) => current.map((entry) => ({ ...entry, value: '' })));
      setNote('');
      await loadSnapshots();
      toast.success('Metric snapshot added');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add metric snapshot');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="space-y-4">
      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <h3 class="mb-3 text-sm font-medium text-fg">Metric definitions</h3>
        {scope.metricDefinitions.length === 0 ? (
          <p class="text-sm text-fg-muted">No metric definitions for this scope.</p>
        ) : (
          <div class="grid gap-3 md:grid-cols-2">
            {scope.metricDefinitions.map((metric) => (
              <div key={metric.key} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="flex items-center justify-between gap-3">
                  <p class="text-sm font-medium text-fg">{metric.label}</p>
                  <span class="text-xs text-fg-muted">{metric.direction}</span>
                </div>
                <p class="mt-1 text-xs text-fg-muted">
                  {metric.key}
                  {metric.unit ? ` · ${metric.unit}` : ''}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {scope.metricDefinitions.length > 0 && (
        <form onSubmit={handleAddSnapshot} class="rounded-xl border border-line bg-fill-soft p-4">
          <h3 class="mb-3 text-sm font-medium text-fg">Add metric snapshot</h3>
          <div class="grid gap-3 md:grid-cols-2">
            {values.map((entry, index) => {
              const metric = scope.metricDefinitions.find(
                (definition) => definition.key === entry.key
              );
              return (
                <label key={entry.key} class="block">
                  <span class="mb-1 block text-xs text-fg-muted">{metric?.label ?? entry.key}</span>
                  <input
                    value={entry.value}
                    onInput={(event) =>
                      updateValue(index, (event.target as HTMLInputElement).value)
                    }
                    placeholder={metric?.unit ?? 'value'}
                    class={FORM_CONTROL_CLASS}
                  />
                </label>
              );
            })}
          </div>
          <textarea
            value={note}
            onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
            placeholder="Optional snapshot note"
            rows={2}
            class={cn(FORM_CONTROL_CLASS, 'mt-3 resize-none')}
          />
          <div class="mt-3 flex justify-end">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add snapshot'}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div class="rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <h3 class="mb-3 text-sm font-medium text-fg">Snapshot history</h3>
        {loading ? (
          <p class="text-sm text-fg-muted">Loading snapshots…</p>
        ) : snapshots.length === 0 ? (
          <p class="text-sm text-fg-muted">No metric snapshots yet.</p>
        ) : (
          <div class="space-y-3">
            {snapshots.map((snapshot) => (
              <div key={snapshot.id} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="mb-2 flex items-center justify-between gap-3">
                  <span class="text-sm text-fg-soft">{snapshot.source}</span>
                  <span class="text-xs text-fg-muted">{formatDate(snapshot.capturedAt)}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  {Object.entries(snapshot.values).map(([key, value]) => (
                    <span
                      key={key}
                      class="rounded-full bg-fill-soft px-2 py-1 text-xs text-fg-soft"
                    >
                      {key}: {String(value)}
                    </span>
                  ))}
                </div>
                {snapshot.note && <p class="mt-2 text-sm text-fg-muted">{snapshot.note}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
