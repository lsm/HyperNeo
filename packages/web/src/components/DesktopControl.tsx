import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { t } from '../lib/i18n/index.ts';
import { invokeOperation } from '../lib/operations.ts';

type DesktopState = 'off' | 'unavailable' | 'running' | 'stopped' | 'stop_unconfirmed';
type DesktopWorker = { worker: string; todo: string | null; state: DesktopState };

const TONE: Record<DesktopState, string> = {
  off: 'bg-fg-faint',
  unavailable: 'bg-warning',
  running: 'bg-success',
  stopped: 'bg-fg-faint',
  stop_unconfirmed: 'bg-danger',
};

export function DesktopControl({ worker, class: className }: { worker?: string; class?: string }) {
  const [workers, setWorkers] = useState<DesktopWorker[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);
  const live = useRef(true);
  const read = useCallback(async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    const result = await invokeOperation<{ workers?: DesktopWorker[] }>(
      hub,
      'desktop.status',
      worker ? { worker } : {}
    ).catch(() => null);
    if (live.current) setWorkers((result?.workers ?? []).filter((entry) => entry.state !== 'off'));
  }, [worker]);
  const active = workers.length > 0;
  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);
  useEffect(() => {
    const timer = setInterval(() => void read(), active ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [read, active]);
  const stop = async (id: string) => {
    setStopping(id);
    const hub = connectionManager.getHubIfConnected();
    if (hub) await invokeOperation(hub, 'desktop.stop', { worker: id }).catch(() => null);
    await read();
    if (live.current) setStopping(null);
  };
  if (workers.length === 0) return null;
  return (
    <section
      aria-label={t('desktop.title')}
      class={`flex flex-col gap-2 text-sm ${className ?? ''}`}
    >
      {!worker && <h3 class="text-sm font-medium text-fg-muted">{t('desktop.title')}</h3>}
      {workers.map((entry) => (
        <div
          key={entry.worker}
          class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2"
        >
          <span aria-hidden="true" class={`h-2.5 w-2.5 rounded-full ${TONE[entry.state]}`} />
          <span class="min-w-0 flex-1">
            <span class="block">{t(`desktop.state.${entry.state}`)}</span>
            {entry.todo && <span class="block truncate text-xs text-fg-muted">{entry.todo}</span>}
          </span>
          {entry.state !== 'stopped' && (
            <button
              type="button"
              disabled={stopping === entry.worker}
              onClick={() => void stop(entry.worker)}
              class="min-h-11 rounded-full border border-danger/30 bg-danger/10 px-4 text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {stopping === entry.worker
                ? t('desktop.stopping')
                : entry.state === 'stop_unconfirmed'
                  ? t('desktop.retry')
                  : t('desktop.stop')}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
