import { getThinkingOptionsForProvider } from '@hyperneo/shared';
import type { ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { filterModelsForPicker, useClickOutside } from '../hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { providerPillStyle, providerLogoColor, shortenModelName } from '../lib/provider-brand.ts';
import { NeoIcon } from '../neo/NeoIcon.tsx';
import { NeoModelMenu } from '../neo/NeoModelMenu.tsx';
import { ProviderLogo } from './ProviderLogo.tsx';
import { ThinkingLevelIcon } from './ThinkingLevelIcon.tsx';
import { Spinner } from './ui/Spinner.tsx';

interface ModelPickerProps {
  activeModelInfo: ModelInfo | null;
  activeModelLabel: string;
  availableModels: ModelInfo[];
  loading: boolean;
  thinkingLevel: ThinkingLevel;
  onSelectModel: (model: ModelInfo) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
  onReload?: () => void;
  menuId?: string;
  disabled?: boolean;
  busy?: boolean;
  align?: 'left' | 'right';
}

function solidPillStyle(provider: string | undefined) {
  const pill = providerPillStyle(provider);
  return {
    borderColor: pill.borderColor,
    backgroundColor: 'var(--color-surface-raised)',
    backgroundImage: `linear-gradient(${pill.backgroundColor}, ${pill.backgroundColor})`,
  };
}

export function ModelPicker({
  activeModelInfo,
  activeModelLabel,
  availableModels,
  loading,
  thinkingLevel,
  onSelectModel,
  onSelectThinking,
  onReload,
  menuId = 'model-preferences',
  disabled = false,
  busy = false,
  align = 'left',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef(0);
  const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
    new Map()
  );
  const isConnected = connectionState.value === 'connected';

  useClickOutside(ref, () => setOpen(false), open);

  const loadAuthStatuses = useCallback(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    const requestId = ++requestIdRef.current;
    hub
      .request<{ providers?: ProviderAuthStatus[] }>('auth.providers', {})
      .then((result) => {
        if (requestId !== requestIdRef.current) return;
        setProviderAuthStatuses(
          new Map((result.providers ?? []).map((provider) => [provider.id, provider]))
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    loadAuthStatuses();
  }, [isConnected, loadAuthStatuses]);

  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    return hub.onEvent('providers.changed', () => {
      loadAuthStatuses();
    });
  }, [loadAuthStatuses, connectionState.value]);

  const activeProvider = activeModelInfo?.provider;
  const models = filterModelsForPicker(
    availableModels,
    providerAuthStatuses,
    activeProvider,
    activeModelInfo?.id
  );
  const options = getThinkingOptionsForProvider(activeProvider, activeModelInfo?.thinkingModes);
  const level = options.some((option) => option.value === thinkingLevel) ? thinkingLevel : 'off';
  const thinking = options.find((option) => option.value === level)?.label ?? 'Off';
  const label = activeModelInfo
    ? shortenModelName(activeModelInfo.name, activeProvider)
    : activeModelLabel;
  const waiting = loading && availableModels.length === 0;

  return (
    <div class="relative min-w-0" ref={ref}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        disabled={waiting || disabled}
        title={`${label} · Thinking: ${thinking}`}
        aria-label="Choose model and thinking"
        aria-expanded={open}
        aria-controls={menuId}
        class="flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border px-2.5 text-xs text-fg-soft transition-colors hover:brightness-110 shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
        style={activeModelInfo ? solidPillStyle(activeProvider) : undefined}
      >
        {waiting || busy ? (
          <Spinner size="sm" />
        ) : activeModelInfo ? (
          <span class="flex shrink-0" style={{ color: providerLogoColor(activeProvider) }}>
            <ProviderLogo provider={activeProvider ?? 'anthropic'} class="h-4 w-4" />
          </span>
        ) : null}
        <span class="min-w-0 truncate">{label}</span>
        <span aria-hidden="true" class="text-fg-faint">
          ·
        </span>
        <span class="shrink-0" role="img" aria-label={`Thinking: ${thinking}`}>
          <ThinkingLevelIcon ring level={level} />
        </span>
        <NeoIcon
          name="chevron"
          class={`!h-3.5 !w-3.5 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <NeoModelMenu
          id={menuId}
          models={models}
          current={activeModelInfo ?? undefined}
          level={level}
          options={options}
          busy={busy}
          align={align}
          loading={loading}
          working={false}
          onModel={onSelectModel}
          onThinking={onSelectThinking}
          onReload={onReload}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
