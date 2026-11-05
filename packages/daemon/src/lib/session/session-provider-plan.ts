import type { GlobalSettings, ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import superpipe, { type PipelineAPI } from 'superpipe';
import { usableModels } from '../usable-models.ts';
import { pickCatalogModel } from './new-session-model.ts';

export const NO_PROVIDER_RETRY_MS = 30_000;
export const NO_PROVIDER_NOTICE =
  'No model service is logged in yet. Log in to one under Providers. Your messages will wait and go out then.';

export const PROVIDER_UNREACHABLE_NOTICE =
  "A model service is set up but isn't answering. Your messages will wait and go out once it responds.";

export interface SessionProviderRequest {
  wanted: string;
  pinned: boolean;
  model: string;
  settings: Pick<GlobalSettings, 'model' | 'modelProvider'>;
}

export type SessionProviderPlan =
  | { kind: 'move'; provider: string; model: string; notice: string | null }
  | { kind: 'wait'; notice: string };

interface OnProviderModels {
  models: ModelInfo[];
  unreachable: boolean;
}

export function decideSessionProvider(
  request: SessionProviderRequest,
  { models, unreachable }: OnProviderModels
): SessionProviderPlan {
  const usable = usableModels(models);
  const { settings } = request;
  const choice =
    pickCatalogModel(usable, request.model, undefined) ??
    (settings.model ? pickCatalogModel(usable, settings.model, settings.modelProvider) : null) ??
    usable[0];
  if (!choice)
    return { kind: 'wait', notice: unreachable ? PROVIDER_UNREACHABLE_NOTICE : NO_PROVIDER_NOTICE };
  return {
    kind: 'move',
    provider: choice.provider,
    model: choice.id,
    notice: request.pinned
      ? `This session was set to ${request.wanted}, which is off. It now uses ${choice.id} on ${choice.provider}.`
      : null,
  };
}

export async function isProviderOn(provider: Provider): Promise<boolean> {
  try {
    return await provider.isAvailable();
  } catch {
    return false;
  }
}

async function readProviderModels(provider: Provider): Promise<ModelInfo[] | null> {
  if (!(await isProviderOn(provider))) return [];
  try {
    return (await provider.getModels()).map((model) => ({ ...model, provider: provider.id }));
  } catch {
    return null;
  }
}

async function readOnProviderModels(providers: Provider[]): Promise<OnProviderModels> {
  const read = await Promise.all(providers.map(readProviderModels));
  return { models: read.flatMap((models) => models ?? []), unreachable: read.includes(null) };
}

export const planSessionProvider = (superpipe({})('plan-session-provider') as PipelineAPI)
  .input(['request', 'providers'])
  .pipe(readOnProviderModels, 'providers', 'models')
  .pipe(decideSessionProvider, ['request', 'models'], 'plan')
  .endAsync('plan') as (
  request: SessionProviderRequest,
  providers: Provider[]
) => Promise<SessionProviderPlan>;
