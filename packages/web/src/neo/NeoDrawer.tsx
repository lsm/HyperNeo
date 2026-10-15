import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import type { ConnectionState } from '../lib/state.ts';
import { useEffect, useRef } from 'preact/hooks';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import { NeoProjectTree } from './NeoProjectTree.tsx';

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
  error: 'Connection error',
  failed: 'Could not connect',
};

export function NeoDrawer({
  open,
  onClose,
  connection,
  onReconnect,
  onRefresh,
  projects,
  refreshProjects,
}: {
  open: boolean;
  onClose: () => void;
  connection: ConnectionState;
  onReconnect: () => void;
  onRefresh: () => void;
  projects: readonly NeoProject[];
  refreshProjects: () => Promise<void>;
}) {
  const dragFrom = useRef<number | null>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open || !panel.current) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const release = setupFocusTrap(panel.current);
    panel.current.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
      setTimeout(() => opener?.focus?.(), 0);
    };
  }, [open, onClose]);
  if (!open) return null;
  const drag = (x: number) => {
    const from = dragFrom.current;
    if (from === null || !panel.current) return 0;
    const dx = Math.min(0, x - from);
    panel.current.style.transform = `translateX(${dx}px)`;
    return dx;
  };
  return (
    <div class="neo-drawer-layer">
      <div class="neo-drawer-backdrop" data-testid="neo-drawer-backdrop" onClick={onClose} />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Settings and connection"
        tabIndex={-1}
        class="neo-drawer"
        onPointerDown={(event) => {
          if ((event.target as Element).closest('button, a, input, select, textarea, label'))
            return;
          dragFrom.current = event.clientX;
        }}
        onPointerMove={(event) => void drag(event.clientX)}
        onPointerUp={(event) => {
          const dx = drag(event.clientX);
          dragFrom.current = null;
          if (panel.current) panel.current.style.transform = '';
          if (dx < -60) onClose();
        }}
        onPointerCancel={() => {
          dragFrom.current = null;
          if (panel.current) panel.current.style.transform = '';
        }}
      >
        <h2 class="mb-5 text-base font-medium">Settings and connection</h2>
        <section aria-label="Connection" class="mb-6">
          <h3 class="mb-2 text-sm font-medium text-fg-muted">Connection</h3>
          <p class="mb-3 flex items-center gap-2 text-sm">
            <span
              aria-hidden="true"
              class={`h-2.5 w-2.5 rounded-full ${
                connection === 'connected'
                  ? 'bg-success'
                  : connection === 'connecting' || connection === 'reconnecting'
                    ? 'bg-warning'
                    : 'bg-danger'
              }`}
            />
            {CONNECTION_TEXT[connection]}
          </p>
          <div class="flex gap-2">
            <button type="button" class="neo-drawer-action" onClick={onReconnect}>
              Reconnect
            </button>
            <button
              type="button"
              class="neo-drawer-action"
              onClick={() => {
                onRefresh();
                onClose();
              }}
            >
              Refresh Neo
            </button>
          </div>
        </section>
        <section aria-labelledby="neo-drawer-projects">
          <h3 id="neo-drawer-projects" class="mb-3 text-sm font-medium text-fg-muted">
            Projects
          </h3>
          <NeoProjectTree projects={projects} refresh={refreshProjects} />
        </section>
      </aside>
    </div>
  );
}
