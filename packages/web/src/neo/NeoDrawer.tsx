import { NeoIcon } from './NeoIcon.tsx';
import { DesktopControl } from '../components/DesktopControl.tsx';
import { PairConfirmInput, pairApprovalReady } from '../components/settings/PairConfirmInput.tsx';
import type { ConnectionState } from '../lib/state.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import { setupFocusTrap } from '../components/ui/Modal.tsx';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { setTheme, themeSetting, type ThemeSetting } from '../lib/theme.ts';
import type { LanguageSetting } from '@hyperneo/shared/types/settings';
import { updateGlobalSettings } from '../lib/api-helpers.ts';
import { languageSetting, t } from '../lib/i18n/index.ts';

const LANGUAGES: { value: LanguageSetting; label: () => string }[] = [
  { value: 'en', label: () => 'English' },
  { value: 'zh-Hans', label: () => '简体中文' },
  { value: 'system', label: () => t('drawer.language.system') },
];

export function NeoDrawer({
  open,
  desktopDialog,
  onClose,
  connection,
  onReconnect,
  onRefresh,
  onOpenSession,
}: {
  open: boolean;
  desktopDialog?: RefObject<HTMLDivElement>;
  onClose: () => void;
  connection: ConnectionState;
  onReconnect: () => void;
  onRefresh: () => void;
  onOpenSession?: (sessionId: string, label?: string) => void;
}) {
  const dragFrom = useRef<number | null>(null);
  const [languageFailed, setLanguageFailed] = useState(false);
  const languageAttempt = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    languageAttempt.current += 1;
    setLanguageFailed(false);
  }, [open]);
  useEffect(() => {
    if (!open || !panel.current) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const desktopContainer = desktopDialog?.current;
    const release = desktopContainer ? undefined : setupFocusTrap(panel.current);
    if (!desktopContainer?.contains(opener)) panel.current.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      release?.();
      setTimeout(() => opener?.focus?.(), 0);
    };
  }, [open, onClose, desktopDialog]);
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
        id={desktopDialog ? 'neo-settings-panel' : undefined}
        role={desktopDialog ? undefined : 'dialog'}
        aria-modal={desktopDialog ? undefined : 'true'}
        aria-label={desktopDialog ? undefined : t('drawer.title')}
        tabIndex={-1}
        class="neo-drawer"
        onPointerDown={(event) => {
          if (
            (event.target as Element).closest(
              'button, a, input, select, textarea, label, [data-tauri-drag-region]'
            )
          )
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
        <div class="neo-drawer-drag-region" data-tauri-drag-region />
        <header class="neo-drawer-heading">
          <h2>{t('drawer.title')}</h2>
          {!desktopDialog && (
            <button
              type="button"
              class="neo-drawer-close"
              aria-label={t('drawer.close')}
              onClick={onClose}
            >
              <NeoIcon name="close" />
            </button>
          )}
        </header>
        <section aria-label={t('drawer.connection')} class="neo-drawer-section">
          <div class="neo-drawer-row">
            <h3>{t('drawer.connection')}</h3>
            <p class="flex items-center gap-2 text-xs text-fg-muted" role="status">
              <span
                aria-hidden="true"
                class={`h-2 w-2 rounded-full ${
                  connection === 'connected'
                    ? 'bg-success'
                    : connection === 'connecting' || connection === 'reconnecting'
                      ? 'bg-warning'
                      : 'bg-danger'
                }`}
              />
              {t(`drawer.status.${connection}`)}
            </p>
          </div>
        </section>
        <section aria-label={t('drawer.language')} class="neo-drawer-section">
          <label class="neo-drawer-row">
            <span>{t('drawer.language')}</span>
            <select
              aria-label={t('drawer.language')}
              value={languageSetting.value}
              disabled={connection !== 'connected'}
              onChange={(event) => {
                const language = event.currentTarget.value as LanguageSetting;
                const attempt = ++languageAttempt.current;
                const settle = (failed: boolean) => {
                  if (attempt === languageAttempt.current) setLanguageFailed(failed);
                };
                setLanguageFailed(false);
                updateGlobalSettings({ language })
                  .then((result) => settle(!result.success))
                  .catch(() => settle(true));
              }}
              class="neo-drawer-select"
              aria-describedby="neo-language-scope"
            >
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label()}
                </option>
              ))}
            </select>
          </label>
          {languageFailed && (
            <p role="alert" class="mt-2 text-sm text-danger">
              {t('drawer.language.failed')}
            </p>
          )}
          <p id="neo-language-scope" class="neo-drawer-hint">
            {t('drawer.language.hint')}
          </p>
        </section>
        <section aria-label={t('drawer.appearance')} class="neo-drawer-section">
          <label class="neo-drawer-row" for="neo-theme-setting">
            <span>{t('drawer.theme')}</span>
            <select
              id="neo-theme-setting"
              value={themeSetting.value}
              onChange={(event) => setTheme(event.currentTarget.value as ThemeSetting)}
              class="neo-drawer-select"
            >
              {(['light', 'dark', 'system'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`drawer.theme.${value}`)}
                </option>
              ))}
            </select>
          </label>
        </section>
        <details class="neo-drawer-section" open={connection !== 'connected'}>
          <summary class="neo-drawer-row">{t('drawer.troubleshoot')}</summary>
          <div class="mb-3 flex flex-wrap gap-2">
            <button type="button" class="neo-drawer-action" onClick={onReconnect}>
              {t('drawer.reconnect')}
            </button>
            <button
              type="button"
              class="neo-drawer-action"
              onClick={() => {
                onRefresh();
                onClose();
              }}
            >
              {t('drawer.refresh')}
            </button>
          </div>
        </details>
        <DesktopControl
          class="mb-6"
          onOpen={
            onOpenSession &&
            ((sessionId, todo) => {
              onClose();
              onOpenSession(sessionId, todo ?? undefined);
            })
          }
        />
        <PendingDevices connection={connection} />
      </aside>
    </div>
  );
}

type PendingDevice = {
  twoWay?: boolean;
  phoneConfirmed?: boolean;
  requestedName?: string | null;
  id: string;
  kind: string;
  name: string | null;
  expiresAt: number;
};
type PendingResult = { ok: true; pending: PendingDevice[] } | { ok: false; reason: string };

function PendingDevices({ connection }: { connection: ConnectionState }) {
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [error, setError] = useState('');
  const [confirmCodes, setConfirmCodes] = useState<Record<string, string>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
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
  const waitingForPhone = pending.some((item) => item.twoWay && !item.phoneConfirmed);
  useEffect(() => {
    if (!waitingForPhone || connection !== 'connected') return;
    const timer = setInterval(() => void read().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [waitingForPhone, connection]);

  const decide = async (
    operation: 'device.pair.approve' | 'device.pair.deny',
    codeId: string,
    confirmCode?: string
  ) => {
    setDeciding(codeId);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before deciding on a device.');
      const result = await invokeOperation<{ ok: boolean; reason?: string }>(hub, operation, {
        codeId,
        ...(confirmCode === undefined ? {} : { confirmCode }),
      });
      if (!result.ok) {
        if (result.reason?.startsWith('wrong_fingerprint:'))
          setPending((current) => current.filter((item) => item.id !== codeId));
        throw new Error(result.reason ?? 'Could not update the device.');
      }
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
        <div key={device.id} class="mb-3 flex flex-wrap items-start justify-between gap-3 text-sm">
          <div>
            <p>{device.requestedName ?? device.name ?? 'Unnamed device'}</p>
            <p class="text-xs text-fg-muted">
              {device.kind} · expires {new Date(device.expiresAt).toLocaleTimeString()}
            </p>
          </div>
          <PairConfirmInput
            pending={device}
            name={device.requestedName ?? device.name ?? 'Unnamed device'}
            value={confirmCodes[device.id] ?? ''}
            onInput={(value) => setConfirmCodes({ ...confirmCodes, [device.id]: value })}
          />
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
                deciding !== null || !pairApprovalReady(device, confirmCodes[device.id] ?? '')
              }
              aria-label={`Allow ${device.requestedName ?? device.name ?? 'Unnamed device'}`}
              onClick={() =>
                void decide(
                  'device.pair.approve',
                  device.id,
                  device.twoWay ? confirmCodes[device.id] : undefined
                )
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
