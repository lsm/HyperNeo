import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal.tsx';
import { connectionManager } from '../../lib/connection-manager.ts';
import type { GetSessionToolInventoryResponse } from '@hyperneo/shared';
import { computeObservedRuntimeState } from '../ToolsModal.utils.ts';

const RUNTIME_MCP_LABELS: Record<string, { title: string; description: string }> = {
  'agent-memory': {
    title: 'Agent memory',
    description: 'Persistent Space memory read/write/search',
  },
  'db-query': {
    title: 'Database queries',
    description: 'Read-only SQLite access scoped to this space',
  },
};

interface TaskToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string | null;
  agentLabel: string;
}

export function TaskToolsModal({ isOpen, onClose, sessionId, agentLabel }: TaskToolsModalProps) {
  const [inventory, setInventory] = useState<GetSessionToolInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const servers = inventory?.mcpServers ?? [];

  useEffect(() => {
    if (!isOpen || !sessionId) {
      setInventory(null);
      setError(null);
      return;
    }

    let cancelled = false;
    let read = 0;
    let cleanups: Array<() => void> = [];
    setInventory(null);
    setLoading(true);
    setError(null);

    void connectionManager
      .getHub()
      .then((hub) => {
        if (cancelled) return;
        const reload = async () => {
          const current = ++read;
          setLoading(true);
          setError(null);
          try {
            const result = await hub.request<GetSessionToolInventoryResponse>(
              'session.getToolInventory',
              { sessionId }
            );
            if (!cancelled && current === read) setInventory(result);
          } catch {
            if (!cancelled && current === read)
              setError('Could not verify running tools. Try Refresh.');
          } finally {
            if (!cancelled && current === read) setLoading(false);
          }
        };
        refresh.current = () => {
          void reload();
        };
        cleanups = [
          hub.onConnection((state) => {
            if (state === 'connected') void reload();
            else {
              read++;
              setInventory(null);
              setLoading(false);
              setError('Not connected. Running tools are unverified.');
            }
          }),
          hub.onEvent<{ sessionId: string }>('session.toolInventory.changed', (event) => {
            if (event.sessionId === sessionId) void reload();
          }),
          hub.onEvent('state.session', (_state, context) => {
            if (context?.channel === `session:${sessionId}`) void reload();
          }),
        ];
        void reload();
      })
      .catch(() => {
        if (cancelled) return;
        setError('Could not verify running tools. Try reopening Tools.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      refresh.current = null;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [isOpen, sessionId]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`${agentLabel} Tools`} size="sm">
      <div class="space-y-3">
        {!sessionId && (
          <p class="text-sm text-fg-muted text-center py-4">
            Start the agent to check its running tools.
          </p>
        )}

        {sessionId && loading && (
          <div class="flex items-center justify-center py-4 gap-2">
            <div class="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span class="text-sm text-fg-muted">
              {inventory ? 'Refreshing tools...' : 'Loading tools...'}
            </span>
          </div>
        )}

        {sessionId && error && <p class="text-sm text-danger-soft text-center py-4">{error}</p>}

        {sessionId && !loading && !error && servers.length === 0 && (
          <p class="text-sm text-fg-muted text-center py-4">
            {inventory?.state === 'observed'
              ? 'No MCP servers observed in this running session.'
              : computeObservedRuntimeState(inventory, '').label}
          </p>
        )}

        {sessionId &&
          !error &&
          servers.map((server) => {
            const label = RUNTIME_MCP_LABELS[server.name];
            return (
              <div
                key={server.name}
                class={`flex items-center gap-3 p-3 rounded-lg bg-surface-raised/50 min-w-0 border border-line-strong`}
              >
                <svg
                  class={`w-4 h-4 flex-shrink-0 ${server.status === 'connected' && server.tools?.length !== 0 ? 'text-success' : 'text-fg-faint'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
                <div class="flex-1 min-w-0">
                  <div class="text-sm text-fg-soft truncate">{label?.title ?? server.name}</div>
                  <div class="text-xs text-fg-muted break-words">
                    {computeObservedRuntimeState(inventory, server.name).label}
                  </div>
                </div>
              </div>
            );
          })}
        {sessionId && (
          <>
            <button
              type="button"
              class="text-xs text-fg-muted"
              disabled={loading || !refresh.current}
              onClick={() => refresh.current?.()}
            >
              Refresh running tools
            </button>
            {!!inventory?.tools.length && (
              <details class="text-xs text-fg-muted">
                <summary>Observed tool names ({inventory.tools.length})</summary>
                <div class="break-words">{inventory.tools.join(', ')}</div>
              </details>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
