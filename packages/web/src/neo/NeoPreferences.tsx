import { getThinkingOptionsForProvider, normalizeThinkingLevel } from '@hyperneo/shared';
import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useModelSwitcher, filterModelsForPicker } from '../hooks/useModelSwitcher.ts';
import { useClickOutside } from '../hooks/useClickOutside.ts';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoModelPreference } from '@hyperneo/shared/types/settings';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { connectionState } from '../lib/state.ts';
import { providerLogoColor, shortenModelName } from '../lib/provider-brand.ts';
import type { SessionStore } from '../lib/session-store.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { NeoModelMenu } from './NeoModelMenu.tsx';
import { ThinkingLevelIcon } from '../components/ThinkingLevelIcon.tsx';
import { ProviderLogo } from '../components/ProviderLogo.tsx';

export type NeoPreference = NeoSnapshot['preferences'];

export function NeoPreferences({
  sessionId,
  store,
  onError,
  preference,
  onSaved,
}: {
  sessionId: string;
  store: SessionStore;
  onError: (message: string) => void;
  preference?: NeoPreference;
  onSaved?: () => void;
}) {
  const model = useModelSwitcher(sessionId);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [auth, setAuth] = useState(new Map<string, ProviderAuthStatus>());
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const connected = connectionState.value === 'connected';
  const chosen = preference
    ? model.availableModels.find(
        (item) =>
          (item.id === preference.model || item.alias === preference.model) &&
          item.provider === preference.provider
      )
    : undefined;
  const info = chosen ?? model.currentModelInfo;
  const currentId = preference?.model ?? model.currentModel;
  const level = normalizeThinkingLevel(
    preference?.thinkingLevel ?? store.sessionInfo.value?.config?.thinkingLevel
  );
  const options = getThinkingOptionsForProvider(info?.provider, info?.thinkingModes);
  const busy = saving || model.loading || !connected;
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
  const available = filterModelsForPicker(model.availableModels, auth, info?.provider, currentId);
  const models = [
    ...new Map(available.map((item) => [JSON.stringify([item.provider, item.id]), item])).values(),
  ];
  const current = models.find(
    (item) =>
      (item.id === currentId || item.alias === currentId) && item.provider === info?.provider
  );
  const name = shortenModelName(info?.name || currentId || 'Model');
  const thinking = options.length
    ? (options.find((option) => option.value === level)?.label ?? 'Off')
    : 'Off';

  async function save(next: NeoModelPreference) {
    setSaving(true);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing the model.');
      const result = await invokeOperation<
        { ok: true; preferences: NeoModelPreference } | { ok: false; reason: string }
      >(hub, 'neo.preferences.set', next);
      if (!result.ok) throw new Error(result.reason);
      onSaved?.();
      await store.refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not change Neo’s model.');
    } finally {
      setSaving(false);
    }
  }

  async function changeModel(next: ModelInfo) {
    if (busy) return;
    if (
      next.provider.startsWith('anthropic') &&
      !info?.provider.startsWith('anthropic') &&
      !confirm(
        'Switching to this provider removes old thinking blocks for compatibility. Your messages and results stay. Continue?'
      )
    )
      return;
    await save({ model: next.id, provider: next.provider, thinkingLevel: level });
  }

  async function changeThinking(next: ThinkingLevel) {
    if (busy || !info || !currentId) return;
    await save({ model: currentId, provider: info.provider, thinkingLevel: next });
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
        <span class="flex shrink-0" style={{ color: providerLogoColor(info?.provider) }}>
          <ProviderLogo provider={info?.provider ?? 'anthropic'} class="h-3.5 w-3.5" />
        </span>
        <span class="max-w-32 truncate">{saving ? 'Switching…' : name}</span>
        <span aria-hidden="true" class="text-fg-faint">
          ·
        </span>
        <span
          class="shrink-0"
          role="img"
          aria-label={`Thinking: ${thinking}`}
          title={`Thinking: ${thinking}`}
        >
          <ThinkingLevelIcon ring level={options.length ? level : 'off'} />
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
