import { getThinkingOptionsForProvider, normalizeThinkingLevel } from '@hyperneo/shared';
import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useModelSwitcher, filterModelsForPicker } from '../hooks/useModelSwitcher.ts';
import { useClickOutside } from '../hooks/useClickOutside.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { shortenModelName } from '../lib/provider-brand.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoModelMenu } from './NeoModelMenu.tsx';
import { ThinkingLevelIcon } from '../components/ThinkingLevelIcon.tsx';

export function NeoPreferences({
  sessionId,
  store,
  onError,
}: {
  sessionId: string;
  store: SessionStore;
  onError: (message: string) => void;
}) {
  const model = useModelSwitcher(sessionId);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [auth, setAuth] = useState(new Map<string, ProviderAuthStatus>());
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const connected = connectionState.value === 'connected';
  const level = normalizeThinkingLevel(store.sessionInfo.value?.config?.thinkingLevel);
  const options = getThinkingOptionsForProvider(
    model.currentModelInfo?.provider,
    model.currentModelInfo?.thinkingModes
  );
  const busy = saving || model.switching || model.loading || !connected || store.isWorking.value;
  useClickOutside(ref, () => setOpen(false), open);
  useEffect(() => {
    if (!open || !connected) return;
    let active = true;
    void connectionManager
      .getHubIfConnected()
      ?.request<{ providers: ProviderAuthStatus[] }>('auth.providers', {})
      .then((result) => {
        if (active) setAuth(new Map(result.providers.map((provider) => [provider.id, provider])));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, connected, model.availableModels]);
  const available = filterModelsForPicker(
    model.availableModels,
    auth,
    model.currentModelInfo?.provider,
    model.currentModel
  );
  const models = [
    ...new Map(available.map((item) => [JSON.stringify([item.provider, item.id]), item])).values(),
  ];
  const current = models.find(
    (item) =>
      (item.id === model.currentModel || item.alias === model.currentModel) &&
      item.provider === model.currentModelInfo?.provider
  );
  const name = shortenModelName(model.currentModelInfo?.name || model.currentModel || 'Model');
  const thinking = options.length
    ? (options.find((option) => option.value === level)?.label ?? 'Off')
    : 'Off';

  async function changeModel(next: ModelInfo) {
    if (busy) return;
    if (
      next.provider.startsWith('anthropic') &&
      !model.currentModelInfo?.provider.startsWith('anthropic') &&
      !confirm(
        'Switching to this provider removes old thinking blocks for compatibility. Your messages and results stay. Continue?'
      )
    )
      return;
    try {
      await model.switchModel(next);
      await store.refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not refresh the selected model.');
    }
  }

  async function changeThinking(next: ThinkingLevel) {
    if (busy) return;
    setSaving(true);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing thinking.');
      await hub.request('session.thinking.set', { sessionId, level: next });
      await store.refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not change thinking.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={ref} class="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-label="Model and thinking"
        aria-expanded={open}
        aria-controls="neo-preferences"
        onClick={() => setOpen(!open)}
        title={`${name} · Thinking: ${thinking}`}
        class="flex max-w-full items-center gap-1.5 rounded-full border border-line bg-fill-soft px-2.5 py-2 text-xs text-fg-muted transition-colors hover:border-accent/30 hover:text-fg sm:gap-2 sm:px-3"
      >
        <NeoIcon name="spark" class="!h-3.5 !w-3.5 text-accent" />
        <span class="max-w-32 truncate">{model.switching ? 'Switching…' : name}</span>
        <span aria-hidden="true" class="text-fg-faint">
          ·
        </span>
        <span
          class="shrink-0"
          role="img"
          aria-label={`Thinking: ${thinking}`}
          title={`Thinking: ${thinking}`}
        >
          <ThinkingLevelIcon level={options.length ? level : 'off'} />
        </span>
        <NeoIcon
          name="chevron"
          class={`!h-3.5 !w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <NeoModelMenu
          models={models}
          current={current}
          level={options.some((option) => option.value === level) ? level : 'off'}
          options={options}
          busy={busy}
          loading={model.loading}
          working={store.isWorking.value}
          onModel={(next) => void changeModel(next)}
          onThinking={(next) => void changeThinking(next)}
          onReload={() => void model.reload()}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
