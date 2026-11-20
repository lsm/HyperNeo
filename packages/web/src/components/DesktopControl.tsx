import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import {
  desktopPreferenceRead,
  readDesktopPreference,
  writeDesktopPreference,
} from '../lib/desktop-preference.ts';
import { t } from '../lib/i18n/index.ts';
import { invokeOperation } from '../lib/operations.ts';
import { connectionState } from '../lib/state.ts';
import { SettingsToggle } from './settings/SettingsSection.tsx';

type DesktopState = 'off' | 'unavailable' | 'running' | 'stopped' | 'stop_unconfirmed';
type DesktopWorker = { worker: string; todo: string | null; state: DesktopState };

const TONE: Record<DesktopState, string> = {
  off: 'bg-fg-faint',
  unavailable: 'bg-warning',
  running: 'bg-success',
  stopped: 'bg-fg-faint',
  stop_unconfirmed: 'bg-danger',
};

export function DesktopControl({
  worker,
  class: className,
  onOpen,
}: {
  worker?: string;
  class?: string;
  onOpen?: (worker: string, todo: string | null) => void;
}) {
  const [workers, setWorkers] = useState<DesktopWorker[]>([]);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Record<string, 'failed' | 'unconfirmed' | undefined>>({});
  const [always, setAlways] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const live = useRef(true);
  const read = useCallback(async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    if (!worker)
      void readDesktopPreference(hub)
        .then((value) => live.current && setAlways(value))
        .catch(() => null);
    const result = await invokeOperation<{ workers?: DesktopWorker[] }>(
      hub,
      'desktop.status',
      worker ? { worker } : {}
    ).catch(() => null);
    if (live.current && Array.isArray(result?.workers))
      setWorkers(result.workers.filter((entry) => entry.state !== 'off'));
  }, [worker]);
  const connected = connectionState.value === 'connected';
  const reread = desktopPreferenceRead.value;
  const active = workers.length > 0;
  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read, connected, reread]);
  useEffect(() => {
    const timer = setInterval(() => void read(), active ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [read, active]);
  const stop = async (id: string) => {
    setStopping((current) => ({ ...current, [id]: true }));
    setOutcome((current) => ({ ...current, [id]: undefined }));
    const hub = connectionManager.getHubIfConnected();
    const result = hub
      ? await invokeOperation<{ state?: string }>(hub, 'desktop.stop', { worker: id }).catch(
          () => null
        )
      : null;
    await read();
    if (!live.current) return;
    setStopping((current) => ({ ...current, [id]: false }));
    const next = !result?.state
      ? 'failed'
      : result.state === 'stop_unconfirmed'
        ? 'unconfirmed'
        : undefined;
    setOutcome((current) => ({ ...current, [id]: next }));
  };
  const toggle = async (value: boolean) => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    setSaving(true);
    const saved = await writeDesktopPreference(hub, value).then(
      () => true,
      () => false
    );
    if (!live.current) return;
    setSaving(false);
    if (saved) setAlways(value);
  };
  if (workers.length === 0 && (worker || always === null)) return null;
  return (
    <section
      aria-label={t('desktop.title')}
      class={`flex flex-col gap-2 text-sm ${className ?? ''}`}
    >
      {!worker && <h3 class="text-sm font-medium text-fg-muted">{t('desktop.title')}</h3>}
      {!worker && always !== null && (
        <div class="flex items-center gap-3">
          <span class="min-w-0 flex-1">
            <span class="block">{t('desktop.always')}</span>
            <span class="block text-xs text-fg-muted">
              {t(always ? 'desktop.always.on' : 'desktop.always.off')}
            </span>
          </span>
          <span class="settings-theme">
            <SettingsToggle
              checked={always}
              disabled={saving}
              aria-label={t('desktop.always')}
              onChange={(value) => void toggle(value)}
            />
          </span>
        </div>
      )}
      {workers.map((entry) => {
        const unconfirmed =
          entry.state === 'stop_unconfirmed' ||
          (outcome[entry.worker] === 'unconfirmed' && entry.state !== 'stopped');
        return (
          <div
            key={entry.worker}
            class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span aria-hidden="true" class={`h-2.5 w-2.5 rounded-full ${TONE[entry.state]}`} />
            <span class="min-w-0 flex-1">
              <span class="block">{t(`desktop.state.${entry.state}`)}</span>
              {entry.todo && onOpen ? (
                <button
                  type="button"
                  onClick={() => onOpen(entry.worker, entry.todo)}
                  class="block max-w-full truncate text-left text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                >
                  {entry.todo}
                </button>
              ) : (
                entry.todo && <span class="block truncate text-xs text-fg-muted">{entry.todo}</span>
              )}
            </span>
            {entry.state !== 'stopped' && (
              <button
                type="button"
                disabled={stopping[entry.worker]}
                onClick={() => void stop(entry.worker)}
                class="min-h-11 rounded-full border border-danger/30 bg-danger/10 px-4 text-danger transition-colors hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stopping[entry.worker]
                  ? t('desktop.stopping')
                  : unconfirmed
                    ? t('desktop.retry')
                    : t('desktop.stop')}
              </button>
            )}
            {outcome[entry.worker] === 'failed' && entry.state !== 'stopped' && (
              <p role="alert" class="w-full text-xs text-danger">
                {t('desktop.stopFailed')}
              </p>
            )}
            {unconfirmed && entry.state !== 'stop_unconfirmed' && (
              <p role="alert" class="w-full text-xs text-danger">
                {t('desktop.state.stop_unconfirmed')}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
