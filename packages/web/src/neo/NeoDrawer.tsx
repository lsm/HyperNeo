import type { ConnectionState } from '../lib/state.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { setTheme, themeSetting, type ThemeSetting } from '../lib/theme.ts';
import { t } from '../lib/i18n/index.ts';
import { FingerprintCheck, lastGroupOf } from '../components/pairing/FingerprintCheck.tsx';

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
}: {
  open: boolean;
  onClose: () => void;
  connection: ConnectionState;
  onReconnect: () => void;
  onRefresh: () => void;
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
        <section aria-label={t('drawer.appearance')} class="mb-6">
          <h3 class="mb-2 text-sm font-medium text-fg-muted">{t('drawer.appearance')}</h3>
          <label class="flex items-center gap-3 text-sm" for="neo-theme-setting">
            <span>{t('drawer.theme')}</span>
            <select
              id="neo-theme-setting"
              value={themeSetting.value}
              onChange={(event) => setTheme(event.currentTarget.value as ThemeSetting)}
              class="neo-drawer-action h-11 min-w-0 flex-1 appearance-auto bg-surface text-fg"
            >
              {(['light', 'dark', 'system'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`drawer.theme.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </section>
        <PendingDevices connection={connection} />
      </aside>
    </div>
  );
}

type PendingDevice = {
  requestedName?: string | null;
  id: string;
  kind: string;
  name: string | null;
  expiresAt: number;
  fingerprint?: string[] | null;
};
type PendingResult = { ok: true; pending: PendingDevice[] } | { ok: false; reason: string };

function PendingDevices({ connection }: { connection: ConnectionState }) {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const live = useRef(true);
  const read = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    const result = await invokeOperation<PendingResult>(hub, 'device.pair.pending', {});
    if (!live.current) return;
    if (result.ok) {
      setPending(result.pending);
      setError('');
    } else
      setError(
        result.reason.startsWith('not_paired')
          ? 'Pair this browser in Settings → Connections & Services → Devices to allow devices.'
          : result.reason
      );
  };
  useEffect(() => {
    live.current = true;
    if (connection === 'connected')
      void read().catch((cause) => {
        if (live.current) setError(String(cause));
      });
    return () => {
      live.current = false;
    };
  }, [connection]);
  const decide = async (
    operation: 'device.pair.approve' | 'device.pair.deny',
    codeId: string,
    lastGroup?: string | null
  ) => {
    setDeciding(codeId);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before deciding on a device.');
      const result = await invokeOperation<{ ok: boolean; reason?: string }>(hub, operation, {
        codeId,
        ...(lastGroup ? { lastGroup } : {}),
      });
      if (!result.ok) throw new Error(result.reason ?? 'Could not update the device.');
      await read();
    } catch (cause) {
      if (live.current) setError(String(cause));
    } finally {
      if (live.current) setDeciding(null);
    }
  };
  if (!pending.length && !error) return null;
  return (
    <section aria-label="Pending devices">
      <h3 class="mb-2 text-sm font-medium text-fg-muted">Pending devices</h3>
      {pending.map((device) => (
        <div key={device.id} class="mb-3 flex items-center justify-between gap-2 text-sm">
          <div class="min-w-0 flex-1">
            <p>{device.requestedName ?? device.name ?? 'Unnamed device'}</p>
            <p class="text-xs text-fg-muted">
              {device.kind} · expires {new Date(device.expiresAt).toLocaleTimeString()}
            </p>
            {device.fingerprint && (
              <FingerprintCheck
                label={device.requestedName ?? device.name ?? 'Unnamed device'}
                groups={device.fingerprint}
                value={groups[device.id] ?? ''}
                onInput={(value) => setGroups({ ...groups, [device.id]: value })}
                onSubmit={(lastGroup) => {
                  if (deciding === null) void decide('device.pair.approve', device.id, lastGroup);
                }}
              />
            )}
          </div>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="neo-drawer-action"
              disabled={deciding !== null}
              aria-label={`Deny ${device.requestedName ?? device.name ?? 'Unnamed device'}`}
              onClick={() => void decide('device.pair.deny', device.id)}
            >
              Deny
            </button>
            <button
              type="button"
              class="neo-drawer-action"
              disabled={
                deciding !== null || (!!device.fingerprint && !lastGroupOf(groups[device.id]))
              }
              aria-label={`Allow ${device.requestedName ?? device.name ?? 'Unnamed device'}`}
              onClick={() =>
                void decide('device.pair.approve', device.id, lastGroupOf(groups[device.id]))
              }
            >
              Allow
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" class="text-sm text-danger">
          {error}
        </p>
      )}
      <p class="text-xs text-fg-muted">
        Allow only a device you just paired with hyperneo pair yourself.
      </p>
    </section>
  );
}
