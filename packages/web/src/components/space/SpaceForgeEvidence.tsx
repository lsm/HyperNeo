import type { EvolutionScope, EvidenceRef, EvolutionEvidenceListResponse } from '@hyperneo/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { EVIDENCE_PAGE_SIZE, formatKind, formatDate } from './space-forge-values.ts';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import { FORM_CONTROL_CLASS } from '../ui/FormField';
import { Button } from '../ui/Button';

export function EvidenceTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadEvidence = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
        scopeId: scope.id,
        limit: EVIDENCE_PAGE_SIZE,
        offset: 0,
      });
      if (requestVersion.current === version) {
        setEvidence(response.evidence ?? []);
        setExhausted((response.evidence ?? []).length < EVIDENCE_PAGE_SIZE);
      }
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load evidence');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    loadEvidence().catch(() => undefined);
  }, [loadEvidence]);

  const loadMoreEvidence = async () => {
    if (loadingMore || exhausted) return;
    const version = ++requestVersion.current;
    setLoadingMore(true);
    try {
      const response = await request<EvolutionEvidenceListResponse>('evolution.evidence.list', {
        scopeId: scope.id,
        limit: EVIDENCE_PAGE_SIZE,
        offset: evidence.length,
      });
      if (requestVersion.current !== version) return;
      const next = response.evidence ?? [];
      setEvidence((current) => [...current, ...next]);
      setExhausted(next.length < EVIDENCE_PAGE_SIZE);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load more evidence');
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const handleAddNote = async (event: Event) => {
    event.preventDefault();
    if (!note.trim()) return;
    try {
      setSubmitting(true);
      setError(null);
      await request<{ evidence: EvidenceRef }>('evolution.evidence.addManualNote', {
        scopeId: scope.id,
        summary: note.trim(),
      });
      setNote('');
      await loadEvidence();
      toast.success('Evidence note attached');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attach note');
    } finally {
      setSubmitting(false);
    }
  };

  const timeline = [...evidence].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div class="space-y-4">
      <form onSubmit={handleAddNote} class="rounded-xl border border-line bg-fill-soft p-4">
        <label class="mb-2 block text-sm font-medium text-fg-soft">Attach manual note</label>
        <textarea
          value={note}
          onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
          placeholder="What happened? What evidence should Evolve remember?"
          rows={3}
          class={cn(FORM_CONTROL_CLASS, 'resize-none')}
        />
        <div class="mt-3 flex justify-end">
          <Button type="submit" size="sm" disabled={submitting || !note.trim()}>
            {submitting ? 'Attaching…' : 'Attach note'}
          </Button>
        </div>
      </form>

      {error && (
        <div class="rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <section class="rounded-xl border border-line bg-fill-soft p-4">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="text-sm font-medium text-fg">Evidence timeline</h3>
          <span class="text-xs text-fg-muted">{timeline.length} items</span>
        </div>
        {loading ? (
          <p class="text-sm text-fg-muted">Loading evidence…</p>
        ) : timeline.length === 0 ? (
          <div class="text-sm text-fg-muted">
            <p>No evidence attached yet.</p>
            <p class="mt-1 text-xs text-fg-muted">
              Attach a completed task, metric snapshot, or manual note before generating an episode.
            </p>
          </div>
        ) : (
          <div class="space-y-3">
            {timeline.map((item) => (
              <div key={item.id} class="rounded-lg border border-line bg-surface/60 p-3">
                <div class="mb-1 flex items-center justify-between gap-3">
                  <span class="rounded-full bg-fill-soft px-2 py-0.5 text-xs text-fg-soft">
                    {formatKind(item.kind)}
                  </span>
                  <span class="text-xs text-fg-muted">{formatDate(item.createdAt)}</span>
                </div>
                <p class="text-sm text-fg-soft">{item.summary}</p>
              </div>
            ))}
            {!exhausted && (
              <div class="pt-1">
                <Button variant="ghost" size="sm" onClick={loadMoreEvidence} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : 'Load more evidence'}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
