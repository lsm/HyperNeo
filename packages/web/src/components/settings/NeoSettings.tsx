import { useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_NEO_ROUTE_TIMEOUT_MS,
  type ModelInfo,
  type NeoSettings as NeoSettingsValue,
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

  const save = (choice: string) => {
    const at = choice.indexOf('|');
    return saveNeo({
      routeModel:
        at > 0 ? { provider: choice.slice(0, at), model: choice.slice(at + 1) } : undefined,
    });
  };

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
        {failure && <p class="mt-2 text-xs text-danger">{neoRouteFailureText(failure)}</p>}
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
