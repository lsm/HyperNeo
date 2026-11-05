import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import { usableModels } from '../usable-models.ts';
import { pickCatalogModel } from './new-session-model.ts';

export const NO_PROVIDER_RETRY_MS = 30_000;
export const NO_PROVIDER_NOTICE =
  'No model service is logged in yet. Log in to one under Providers. Your messages will wait and go out then.';

export interface SessionProviderRequest {
  wanted: string;
  pinned: boolean;
  model: string;
  settings: Pick<GlobalSettings, 'model' | 'modelProvider'>;
}

export type SessionProviderPlan =
  | { kind: 'move'; provider: string; model: string; notice: string | null }
  | { kind: 'wait'; notice: string };

export function decideSessionProvider(
  request: SessionProviderRequest,
  models: ModelInfo[]
): SessionProviderPlan {
  const usable = usableModels(models);
  const { settings } = request;
  const choice =
    pickCatalogModel(usable, request.model, undefined) ??
    (settings.model ? pickCatalogModel(usable, settings.model, settings.modelProvider) : null) ??
    usable[0];
  if (!choice) return { kind: 'wait', notice: NO_PROVIDER_NOTICE };
  return {
    kind: 'move',
    provider: choice.provider,
    model: choice.id,
    notice: request.pinned
      ? `This session was set to ${request.wanted}, which is off. It now uses ${choice.id} on ${choice.provider}.`
      : null,
  };
}

async function readOnProviderModels(providers: Provider[]): Promise<ModelInfo[]> {
  const models = await Promise.all(
    providers.map(async (provider) => {
      try {
        if (!(await provider.isAvailable())) return [];
        return (await provider.getModels()).map((model) => ({ ...model, provider: provider.id }));
      } catch {
        return [];
      }
    })
  );
  return models.flat();
}

export const planSessionProvider = (superpipe({})('plan-session-provider') as PipelineAPI)
  .input(['request', 'providers'])
  .pipe(readOnProviderModels, 'providers', 'models')
  .pipe(decideSessionProvider, ['request', 'models'], 'plan')
  .endAsync('plan') as (
  request: SessionProviderRequest,
  providers: Provider[]
) => Promise<SessionProviderPlan>;
