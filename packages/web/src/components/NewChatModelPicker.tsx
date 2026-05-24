import type { ModelInfo } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  getModelFamilyIcon,
  getProviderLabel,
  groupModelsByProvider,
  useClickOutside,
  useFilteredModelsForPicker,
  useModal,
} from '../hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { Spinner } from './ui/Spinner.tsx';

interface NewChatModelPickerProps {
  activeModelInfo: ModelInfo | null;
  activeModelLabel: string;
  availableModels: ModelInfo[];
  loading: boolean;
  onSelectModel: (model: ModelInfo) => void;
}

function providerDotClass(status: ProviderAuthStatus | undefined): string {
  if (!status) return 'bg-gray-500';
  if (!status.isAuthenticated) return 'bg-red-500';
  if (status.needsRefresh) return 'bg-yellow-500';
  return 'bg-green-500';
}

export function NewChatModelPicker({
  activeModelInfo,
  activeModelLabel,
  availableModels,
  loading,
  onSelectModel,
}: NewChatModelPickerProps) {
  const dropdown = useModal();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
    new Map()
  );
  const isConnected = connectionState.value === 'connected';

  useClickOutside(dropdownRef, dropdown.close, dropdown.isOpen);

  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    hub
      .request<{ providers?: ProviderAuthStatus[] }>('auth.providers', {})
      .then((result) => {
        if (cancelled) return;
        const statusMap = new Map<string, ProviderAuthStatus>();
        for (const provider of result.providers ?? []) {
          statusMap.set(provider.id, provider);
        }
        setProviderAuthStatuses(statusMap);
      })
      .catch(() => {
        // Provider dots stay gray if auth status is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected]);

  useEffect(() => {
    if (!dropdown.isOpen) setSearchQuery('');
  }, [dropdown.isOpen]);

  const filteredModels = useFilteredModelsForPicker(
    availableModels,
    providerAuthStatuses,
    activeModelInfo?.provider,
    searchQuery
  );
  const groupedModels = groupModelsByProvider(filteredModels);
  const activeModelKey = activeModelInfo
    ? `${activeModelInfo.provider}:${activeModelInfo.id}`
    : null;
  const activeIcon = activeModelInfo ? getModelFamilyIcon(activeModelInfo.family) : '💎';

  const modelCountLabel = useMemo(() => {
    if (loading) return 'Loading models';
    if (availableModels.length === 0) return 'No models loaded';
    return `${availableModels.length} models`;
  }, [availableModels.length, loading]);

  return (
    <div class="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={dropdown.toggle}
        disabled={loading && availableModels.length === 0}
        title="Choose model"
        aria-label="Choose model"
        class="flex h-8 max-w-[240px] items-center gap-2 rounded-full px-2.5 text-xs text-gray-300 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading && availableModels.length === 0 ? (
          <Spinner size="sm" />
        ) : (
          <span class="text-sm leading-none">{activeIcon}</span>
        )}
        <span class="min-w-0 truncate">{activeModelLabel}</span>
        {activeModelInfo?.provider && (
          <span
            class={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${providerDotClass(
              providerAuthStatuses.get(activeModelInfo.provider)
            )}`}
            title={getProviderLabel(activeModelInfo.provider)}
            aria-label={getProviderLabel(activeModelInfo.provider)}
          />
        )}
        <svg
          class="h-3.5 w-3.5 flex-shrink-0 text-gray-500"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fill-rule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clip-rule="evenodd"
          />
        </svg>
      </button>

      {dropdown.isOpen && (
        <div class="absolute bottom-full left-0 z-50 mb-2 flex max-h-[52vh] w-72 flex-col rounded-xl border border-dark-700 bg-dark-800 py-1 shadow-2xl">
          <div class="flex items-center justify-between px-3 py-1.5">
            <span class="text-xs font-semibold text-gray-400">Model</span>
            <span class="text-[10px] text-gray-600">{modelCountLabel}</span>
          </div>
          <div class="px-2 pb-2">
            <input
              type="search"
              value={searchQuery}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              placeholder="Search models..."
              aria-label="Search models"
              class="w-full rounded-md border border-dark-600 bg-dark-900 px-2 py-1.5 text-xs text-gray-100 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            {Array.from(groupedModels.entries()).map(([provider, models], groupIndex) => {
              const authStatus = providerAuthStatuses.get(provider);
              return (
                <div key={provider}>
                  {groupIndex > 0 && <div class="mx-2 my-1 border-t border-dark-700" />}
                  <div class="flex items-center gap-1.5 px-3 py-1">
                    <span
                      class={`h-2 w-2 flex-shrink-0 rounded-full ${providerDotClass(authStatus)}`}
                    />
                    <span class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                      {getProviderLabel(provider)}
                    </span>
                    {authStatus?.needsRefresh && (
                      <span class="text-[10px] text-yellow-400" title="Token expiring soon">
                        !
                      </span>
                    )}
                  </div>
                  {models.map((model) => {
                    const isActive = `${model.provider}:${model.id}` === activeModelKey;
                    return (
                      <button
                        key={`${model.provider}:${model.id}`}
                        type="button"
                        class={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-dark-700 ${
                          isActive ? 'text-blue-400' : 'text-gray-200'
                        }`}
                        onClick={() => {
                          onSelectModel(model);
                          dropdown.close();
                        }}
                      >
                        <span class="text-base">{getModelFamilyIcon(model.family)}</span>
                        <span class="min-w-0 flex-1 truncate">{model.name}</span>
                        {isActive && <span class="text-[10px] text-blue-400">✓</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {filteredModels.length === 0 && (
              <div class="px-3 py-4 text-center text-xs text-gray-500">No matching models</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
