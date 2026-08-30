import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ModelInfo } from '@hyperneo/shared';
import { connectionManager } from '../../../lib/connection-manager';
import {
  groupModelsByProvider,
  mapRawModelsToModelInfos,
  PROVIDER_LABELS,
  getProviderLabel,
  type RawModelEntry,
} from '../../../hooks/useModelSwitcher';

export interface WorkflowModelSelection {
  modelId: string;
  provider: string;
}

interface WorkflowModelSelectProps {
  value?: string;
  provider?: string;
  onChange: (value: string | undefined, selection?: WorkflowModelSelection) => void;
  testId: string;
  className?: string;
}

type LoadState = 'loading' | 'ready' | 'no-providers';

function encodeModelValue(model: Pick<ModelInfo, 'provider' | 'id'>): string {
  return encodeURIComponent(JSON.stringify([model.provider, model.id]));
}

function dedupeModelsByProviderAndId(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const deduped: ModelInfo[] = [];
  for (const model of models) {
    const key = encodeModelValue(model);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(model);
  }
  return deduped;
}

function decodeModelValue(value: string, models: ModelInfo[]): WorkflowModelSelection {
  const match = models.find((model) => encodeModelValue(model) === value);
  if (match) return { provider: match.provider, modelId: match.id };
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { provider: parsed[0], modelId: parsed[1] };
    }
  } catch {}
  return { provider: '', modelId: value };
}

export function WorkflowModelSelect({
  value,
  provider,
  onChange,
  testId,
  className = 'w-full text-xs bg-surface-raised border border-line-strong rounded px-2 py-1.5 text-fg-soft focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed',
}: WorkflowModelSelectProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [selectedProvider, setSelectedProvider] = useState<string | undefined>(provider);
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(value);
  const previousProvider = useRef<string | undefined>(provider);

  useEffect(() => {
    const providerChanged = provider !== previousProvider.current;
    previousProvider.current = provider;
    if (!value) {
      setSelectedModelId(undefined);
      setSelectedProvider(undefined);
      return;
    }
    if (value === selectedModelId) {
      if (providerChanged) setSelectedProvider(provider);
      return;
    }
    setSelectedModelId(value);
    setSelectedProvider(provider);
  }, [provider, selectedModelId, value]);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const hub = await connectionManager.getHub();
        if (cancelled) return;
        const response = (await hub.request('models.list', {
          useCache: true,
        })) as { models: RawModelEntry[] };
        if (cancelled) return;
        const loaded = dedupeModelsByProviderAndId(mapRawModelsToModelInfos(response.models ?? []));
        setModels(loaded);
        setLoadState(loaded.length > 0 ? 'ready' : 'no-providers');
      } catch {
        if (!cancelled) {
          setModels([]);
          setLoadState('no-providers');
        }
      }
    }

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveProvider = provider ?? selectedProvider;
  const selectedValue = (() => {
    if (!value) return '';
    if (effectiveProvider) return encodeModelValue({ provider: effectiveProvider, id: value });
    const match = models.find((model) => model.id === value);
    return match ? encodeModelValue(match) : value;
  })();
  const groupedModels = useMemo(() => groupModelsByProvider(models), [models]);
  const hasCurrentOutsideList =
    !!value &&
    !models.some(
      (model) => model.id === value && (!effectiveProvider || model.provider === effectiveProvider)
    );

  if (loadState === 'loading') {
    return (
      <select data-testid={testId} disabled class={className}>
        <option>Loading models…</option>
      </select>
    );
  }

  if (loadState === 'no-providers') {
    return (
      <select data-testid={testId} disabled class={className}>
        <option>No providers available</option>
      </select>
    );
  }

  return (
    <select
      data-testid={testId}
      value={selectedValue}
      onChange={(e) => {
        const nextValue = (e.currentTarget as HTMLSelectElement).value;
        if (!nextValue) {
          setSelectedModelId(undefined);
          setSelectedProvider(undefined);
          onChange(undefined);
          return;
        }
        const selection = decodeModelValue(nextValue, models);
        setSelectedModelId(selection.modelId);
        setSelectedProvider(selection.provider);
        onChange(selection.modelId, selection);
      }}
      class={className}
    >
      <option value="">— No override —</option>
      {hasCurrentOutsideList && (
        <option
          value={selectedValue}
        >{`Current (${effectiveProvider ? `${effectiveProvider}:` : ''}${value})`}</option>
      )}
      {Array.from(groupedModels.entries()).map(([provider, providerModels]) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider] || getProviderLabel(provider)}>
          {providerModels.map((model) => (
            <option key={encodeModelValue(model)} value={encodeModelValue(model)}>
              {`${model.name} (${model.id})`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
