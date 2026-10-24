import { normalizeThinkingLevel, THINKING_OPTIONS } from '@hyperneo/shared';
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
import { t } from '../lib/i18n/index.ts';
import { ThinkingLevelIcon } from '../components/ThinkingLevelIcon.tsx';
import { ProviderLogo } from '../components/ProviderLogo.tsx';

export type NeoPreference = NeoSnapshot['preferences'];

export function NeoPreferences({
  sessionId,
  store,
  onError,
  preference,
  onSaved,
  forSession,
}: {
  sessionId: string;
  store: SessionStore;
  onError: (message: string) => void;
  preference?: NeoPreference;
  onSaved?: () => void;
  forSession?: boolean;
}) {
  const pending = store.sessionInfo.value?.metadata?.pendingModelSwitch ?? null;
  const model = useModelSwitcher(sessionId, pending);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [auth, setAuth] = useState(new Map<string, ProviderAuthStatus>());
  const [saved, setSaved] = useState<NeoModelPreference | null>(null);
  useEffect(() => setSaved(null), [preference]);
  const neo = forSession ? undefined : (saved ?? preference);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const connected = connectionState.value === 'connected';
  const pendingInfo = pending
    ? model.availableModels.find(
        (item) =>
          (item.id === pending.model || item.alias === pending.model) &&
          item.provider === pending.provider
      )
    : undefined;
  const chosen = neo
    ? model.availableModels.find(
        (item) =>
          (item.id === neo.model || item.alias === neo.model) && item.provider === neo.provider
      )
    : undefined;
  const info = chosen ?? model.currentModelInfo;
  const currentId = neo?.model || model.currentModel;
  const level = normalizeThinkingLevel(
    neo?.thinkingLevel || store.sessionInfo.value?.config?.thinkingLevel
  );
  const options = THINKING_OPTIONS;
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
  const name = pending
    ? shortenModelName(pendingInfo?.name || pending.model)
    : shortenModelName(info?.name || currentId || 'Model');
  const thinking = options.find((option) => option.value === level)?.label ?? 'Off';

  async function save(next: NeoModelPreference, picked = false) {
    setSaving(true);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect before changing the model.');
      if (forSession) {
        if ((picked && pending) || next.model !== currentId || next.provider !== info?.provider) {
          const switched = await hub.request<{ success: boolean; error?: string }>(
            'session.model.switch',
            { sessionId, model: next.model, provider: next.provider }
          );
          if (!switched.success) throw new Error(switched.error || t('session.modelFailed'));
        }
        if (next.thinkingLevel !== level)
          await hub.request('session.thinking.set', { sessionId, level: next.thinkingLevel });
        await Promise.all([model.reload(), store.refresh()]);
        return;
      }
      const autoCompactPercent = [neo, ...(neo?.fallbacks ?? [])].find(
        (entry) => entry?.model === next.model && entry.provider === next.provider
      )?.autoCompactPercent;
      const result = await invokeOperation<
        { ok: true; preferences: NeoModelPreference } | { ok: false; reason: string }
      >(
        hub,
        'neo.preferences.set',
        autoCompactPercent === undefined ? next : { ...next, autoCompactPercent }
      );
      if (!result.ok) throw new Error(result.reason);
      setSaved(result.preferences);
      onSaved?.();
      await store.refresh();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : forSession
            ? t('session.modelFailed')
            : 'Could not change Neo’s model.'
      );
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
    await save({ model: next.id, provider: next.provider, thinkingLevel: level }, true);
  }

  async function changeThinking(next: ThinkingLevel) {
    if (busy) return;
    if (!info || !currentId) {
      onError(
        forSession
          ? t('session.modelLoading')
          : 'Neo’s model hasn’t loaded yet. Try again in a moment.'
      );
      return;
    }
    await save({ model: currentId, provider: info.provider, thinkingLevel: next });
  }

  return (
    <div ref={ref} class="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-label="Model and thinking"
        aria-expanded={open}
        aria-controls={forSession ? 'neo-preferences-session' : 'neo-preferences'}
        onClick={() => setOpen(!open)}
        title={`${name} · Thinking: ${thinking}`}
        class="flex max-w-full items-center gap-1.5 rounded-full border border-line bg-fill-soft px-2.5 py-2 text-xs text-fg-muted transition-colors hover:border-accent/30 hover:text-fg sm:gap-2 sm:px-3"
      >
        <span class="flex shrink-0" style={{ color: providerLogoColor(info?.provider) }}>
          <ProviderLogo provider={info?.provider ?? 'anthropic'} class="h-3.5 w-3.5" />
        </span>
        <span class="max-w-32 truncate">
          {saving
            ? 'Switching…'
            : pending
              ? shortenModelName(pendingInfo?.name || pending.model)
              : name}
        </span>
        {pending && !saving && (
          <span data-pending-model-switch class="shrink-0 text-[11px] text-accent">
            {t('composer.switchesNextTurn')}
          </span>
        )}
        <span aria-hidden="true" class="text-fg-faint">
          ·
        </span>
        <span
          class="shrink-0"
          role="img"
          aria-label={`Thinking: ${thinking}`}
          title={`Thinking: ${thinking}`}
        >
          <ThinkingLevelIcon level={level} />
        </span>
        <NeoIcon
          name="chevron"
          class={`!h-3.5 !w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <NeoModelMenu
          id={forSession ? 'neo-preferences-session' : 'neo-preferences'}
          models={models}
          current={current}
          level={level}
          busy={busy}
          loading={model.loading}
          working={store.isWorking.value}
          scope={
            forSession
              ? { idle: t('session.modelScope'), working: t('session.modelScopeWorking') }
              : { idle: 'For Neo and all its projects', working: 'Neo switches after this reply' }
          }
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
