import { useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_NEO_ROUTE_TIMEOUT_MS,
  THINKING_LEVELS,
  THINKING_LEVEL_LABELS,
  type ModelInfo,
  type NeoRouteModel,
  type NeoSettings as NeoSettingsValue,
  type ThinkingLevel,
} from '@hyperneo/shared';
import { connectionState, globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { getRelativeTime } from '../../lib/utils.ts';
import {
  getProviderLabel,
  mapRawModelsToModelInfos,
  type RawModelEntry,
} from '../../hooks/useModelSwitcher.ts';
import { Button } from '../ui/Button.tsx';
import { SettingsRow, SettingsSection, SettingsSelect } from './SettingsSection.tsx';

const DEFAULT_CHOICE = '';

export function neoRouteModelChoice(provider: string, model: string): string {
  return `${provider}|${model}`;
}

export function neoRouteModelOptions(
  models: readonly ModelInfo[],
  current: string
): Array<{ value: string; label: string }> {
  const options = [
    { value: DEFAULT_CHOICE, label: "Default provider's title model" },
    ...models.map((model) => ({
      value: neoRouteModelChoice(model.provider, model.id),
      label: `${getProviderLabel(model.provider)} — ${model.name}`,
    })),
  ];
  return current && !options.some((option) => option.value === current)
    ? [...options, { value: current, label: `${current.replace('|', ' — ')} (unavailable)` }]
    : options;
}

const THINKING_OPTIONS = THINKING_LEVELS.map((value) => ({
  value,
  label: THINKING_LEVEL_LABELS[value],
}));

export function readNeoRouteModel(
  choice: string,
  thinkingLevel?: ThinkingLevel
): NeoRouteModel | undefined {
  const at = choice.indexOf('|');
  if (at <= 0) return undefined;
  return {
    provider: choice.slice(0, at),
    model: choice.slice(at + 1),
    ...(thinkingLevel && thinkingLevel !== 'off' ? { thinkingLevel } : {}),
  };
}

export function addNeoRouteFallback(
  fallbacks: readonly NeoRouteModel[],
  models: readonly ModelInfo[],
  primary: NeoRouteModel | undefined
): NeoRouteModel[] {
  const used = new Set(
    [primary, ...fallbacks].flatMap((item) =>
      item ? [neoRouteModelChoice(item.provider, item.model)] : []
    )
  );
  const next = models.find((model) => !used.has(neoRouteModelChoice(model.provider, model.id)));
  return next ? [...fallbacks, { provider: next.provider, model: next.id }] : [...fallbacks];
}

export function moveNeoRouteFallbackUp(
  fallbacks: readonly NeoRouteModel[],
  index: number
): NeoRouteModel[] {
  if (index <= 0 || index >= fallbacks.length) return [...fallbacks];
  const next = [...fallbacks];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

const ROUTE_TIMEOUT_SECONDS = [5, 10, 15, 20, 30, 60];

export function neoRouteTimeoutOptions(currentMs: number): Array<{ value: string; label: string }> {
  const seconds = ROUTE_TIMEOUT_SECONDS.includes(currentMs / 1000)
    ? ROUTE_TIMEOUT_SECONDS
    : [...ROUTE_TIMEOUT_SECONDS, currentMs / 1000].sort((a, b) => a - b);
  return seconds.map((value) => ({
    value: String(value * 1000),
    label: value * 1000 === DEFAULT_NEO_ROUTE_TIMEOUT_MS ? `${value} s (default)` : `${value} s`,
  }));
}

type RouteFailure = { at: number; signal: string; cause: string };

export function neoRouteFailureText(failure: RouteFailure, now = Date.now()): string {
  return `Last routing failure · ${getRelativeTime(failure.at, now)} — ${failure.cause}`;
}

export function NeoSettings() {
  const routeModel = globalSettings.value?.neo?.routeModel;
  const current = routeModel ? neoRouteModelChoice(routeModel.provider, routeModel.model) : '';
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<RouteFailure | null>(null);

  const isConnected = connectionState.value === 'connected';
  useEffect(() => {
    if (!isConnected) return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    let live = true;
    (hub.request('models.list', { useCache: true }) as Promise<{ models: RawModelEntry[] }>)
      .then((response) => {
        if (live) setModels(mapRawModelsToModelInfos(response.models));
      })
      .catch(() => {
        if (live) setModels([]);
      });
    invokeOperation<{ failure: RouteFailure | null }>(hub, 'neo.route.failure', {})
      .then((response) => {
        if (live) setFailure(response.failure);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [isConnected]);

  const timeoutMs = globalSettings.value?.neo?.routeTimeoutMs ?? DEFAULT_NEO_ROUTE_TIMEOUT_MS;

  const saveNeo = async (patch: Partial<NeoSettingsValue>) => {
    setSaving(true);
    try {
      await updateGlobalSettings({ neo: { ...globalSettings.value?.neo, ...patch } });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save Neo settings');
    } finally {
      setSaving(false);
    }
  };

  const fallbacks = globalSettings.value?.neo?.routeFallbacks ?? [];
  const save = (choice: string, thinkingLevel = routeModel?.thinkingLevel) =>
    saveNeo({ routeModel: readNeoRouteModel(choice, thinkingLevel) });
  const saveFallbacks = (next: NeoRouteModel[]) => saveNeo({ routeFallbacks: next });
  const replaceFallback = (index: number, next: NeoRouteModel | undefined) =>
    saveFallbacks(fallbacks.flatMap((item, at) => (at !== index ? [item] : next ? [next] : [])));

  return (
    <SettingsSection title="Neo">
      <SettingsRow
        label="Routing model"
        description="The small model that decides which topic answers each message sent to Neo. It reads the recent conversation and replies with one id, so a fast, cheap model works well."
        layout="stacked"
      >
        <SettingsSelect
          value={current}
          onChange={(choice) => void save(choice)}
          options={neoRouteModelOptions(models, current)}
          disabled={saving}
        />
        {routeModel && (
          <div class="mt-2">
            <SettingsSelect
              value={routeModel.thinkingLevel ?? 'off'}
              onChange={(level) => void save(current, level as ThinkingLevel)}
              options={THINKING_OPTIONS}
              disabled={saving}
            />
          </div>
        )}
        {failure && <p class="mt-2 text-xs text-danger">{neoRouteFailureText(failure)}</p>}
      </SettingsRow>
      <SettingsRow
        label="Fallback models"
        description="Tried in order when the routing model is unavailable or refused. A model that answers is never retried with a fallback."
        layout="stacked"
      >
        {fallbacks.map((item, index) => {
          const choice = neoRouteModelChoice(item.provider, item.model);
          return (
            <div key={`${choice}-${index}`} class="mb-2 flex flex-wrap items-center gap-2">
              <SettingsSelect
                value={choice}
                onChange={(next) =>
                  void replaceFallback(index, readNeoRouteModel(next, item.thinkingLevel))
                }
                options={neoRouteModelOptions(models, choice).filter((option) => option.value)}
                disabled={saving}
              />
              <SettingsSelect
                value={item.thinkingLevel ?? 'off'}
                onChange={(level) =>
                  void replaceFallback(index, readNeoRouteModel(choice, level as ThinkingLevel))
                }
                options={THINKING_OPTIONS}
                disabled={saving}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void saveFallbacks(moveNeoRouteFallbackUp(fallbacks, index))}
                disabled={saving || index === 0}
              >
                Move up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void replaceFallback(index, undefined)}
                disabled={saving}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void saveFallbacks(addNeoRouteFallback(fallbacks, models, routeModel))}
          disabled={saving || !models.length}
        >
          Add fallback
        </Button>
      </SettingsRow>
      <SettingsRow
        label="Routing timeout"
        description="How long Neo waits for the routing model. If it takes longer, the timeout is recorded as a routing failure and the message goes to a clearly matching topic, or stays with Neo."
        layout="stacked"
      >
        <SettingsSelect
          value={String(timeoutMs)}
          onChange={(value) => void saveNeo({ routeTimeoutMs: Number(value) })}
          options={neoRouteTimeoutOptions(timeoutMs)}
          disabled={saving}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
