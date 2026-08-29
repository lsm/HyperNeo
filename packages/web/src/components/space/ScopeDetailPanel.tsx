import type { EvolutionScope, EvolutionScopeGetResponse } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useMessageHub } from '../../hooks/useMessageHub';
import { spaceStore } from '../../lib/space-store';
import { InspectPanel } from '../ui/InspectPanel';
import { ScopeDetail } from './SpaceForge';

interface ScopeDetailPanelProps {
  spaceId: string;
  scopeId: string;
}

export function ScopeDetailPanel({ spaceId, scopeId }: ScopeDetailPanelProps) {
  const { request } = useMessageHub();
  const goals = spaceStore.spaceId.value === spaceId ? spaceStore.goals.value : [];
  const [scope, setScope] = useState<EvolutionScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    setScope(null);
    setLoading(true);
    setError(null);
    request<EvolutionScopeGetResponse>('evolution.scope.get', { id: scopeId })
      .then((response) => {
        if (requestVersion.current !== version) return;
        setScope(response.scope ?? null);
      })
      .catch((err) => {
        if (requestVersion.current !== version) return;
        setError(err instanceof Error ? err.message : 'Failed to load scope');
      })
      .finally(() => {
        if (requestVersion.current === version) setLoading(false);
      });
  }, [scopeId, request]);

  if (loading && !scope) {
    return (
      <InspectPanel
        emptyState={
          <div class="flex h-full items-center justify-center p-6 text-sm text-fg-muted">
            Loading…
          </div>
        }
      />
    );
  }

  if (error || !scope) {
    return (
      <InspectPanel
        emptyState={
          <div class="flex h-full items-center justify-center p-6 text-center text-sm text-fg-muted">
            {error ?? 'This scope is no longer available.'}
          </div>
        }
      />
    );
  }

  return <ScopeDetail scope={scope} goals={goals} onScopeUpdated={setScope} />;
}
