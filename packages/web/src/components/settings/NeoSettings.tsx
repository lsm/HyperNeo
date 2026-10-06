import { useEffect, useState } from 'preact/hooks';
import type { ModelInfo } from '@hyperneo/shared';
import { connectionState, globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager';
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

export function NeoSettings() {
  const routeModel = globalSettings.value?.neo?.routeModel;
  const current = routeModel ? neoRouteModelChoice(routeModel.provider, routeModel.model) : '';
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);

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
    return () => {
      live = false;
    };
  }, [isConnected]);

  const save = async (choice: string) => {
    const at = choice.indexOf('|');
    setSaving(true);
    try {
      await updateGlobalSettings({
        neo: {
          ...globalSettings.value?.neo,
          routeModel:
            at > 0 ? { provider: choice.slice(0, at), model: choice.slice(at + 1) } : undefined,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save the Neo routing model');
    } finally {
      setSaving(false);
    }
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
      </SettingsRow>
    </SettingsSection>
  );
}
