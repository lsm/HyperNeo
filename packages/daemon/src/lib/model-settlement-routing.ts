import type { ModelInfo } from '@hyperneo/shared';
import type { Provider } from '@hyperneo/shared/provider';
import type { ProviderLoadFailure, ProviderModelLoadResult } from './model-service.js';
import { classifyProviderFailure } from './providers/provider-failure-store.js';

export type ProviderLoadOutcome =
  | { kind: 'superseded'; providerId: string; models: ModelInfo[] }
  | { kind: 'failed'; providerId: string; models: ModelInfo[]; failure?: ProviderLoadFailure }
  | { kind: 'unavailable'; providerId: string; models: ModelInfo[] }
  | { kind: 'loaded'; providerId: string; models: ModelInfo[] };

export interface ProviderLoadClassificationContext {
  readonly appliedSeq?: ReadonlyMap<string, number>;
  readonly cachedModels?: readonly ModelInfo[];
  readonly forceRemote?: boolean;
}

export interface ProviderLoadOutcomeClassification {
  readonly outcomes: ProviderLoadOutcome[];
  readonly forcedDiscoveryError?: unknown;
}

export function classifyProviderLoadOutcomes(
  results: readonly PromiseSettledResult<ProviderModelLoadResult>[],
  providers: readonly Pick<Provider, 'id' | 'listRemoteModels'>[],
  loadSeq: number,
  context: ProviderLoadClassificationContext = {}
): ProviderLoadOutcomeClassification {
  const outcomes: ProviderLoadOutcome[] = [];
  let forcedDiscoveryError: unknown;
  results.forEach((result, index) => {
    const provider = providers[index];
    if (result.status !== 'fulfilled') return;
    if ((context.appliedSeq?.get(provider.id) ?? 0) > loadSeq) {
      outcomes.push({
        kind: 'superseded',
        providerId: provider.id,
        models: context.cachedModels?.filter((model) => model.provider === provider.id) ?? [],
      });
      return;
    }
    const value = result.value;
    if (value.status === 'failed') {
      const failure =
        value.error !== undefined
          ? { providerId: provider.id, ...classifyProviderFailure(value.error) }
          : undefined;
      if (
        failure !== undefined &&
        context.forceRemote &&
        provider.listRemoteModels &&
        forcedDiscoveryError === undefined
      ) {
        forcedDiscoveryError = value.error;
      }
      outcomes.push({ kind: 'failed', providerId: provider.id, models: value.models, failure });
      return;
    }
    if (value.status === 'unavailable') {
      outcomes.push({ kind: 'unavailable', providerId: provider.id, models: value.models });
      return;
    }
    outcomes.push({ kind: 'loaded', providerId: provider.id, models: value.models });
  });
  return forcedDiscoveryError === undefined ? { outcomes } : { outcomes, forcedDiscoveryError };
}

export type ProviderRetryAction = 'arm' | 'cancel' | 'clear' | 'keep';

export function decideProviderRetryAction(outcome: ProviderLoadOutcome): ProviderRetryAction {
  if (outcome.kind === 'loaded') return 'clear';
  if (outcome.kind !== 'failed' || outcome.failure === undefined) return 'keep';
  return outcome.failure.errorKind === 'transient' ? 'arm' : 'cancel';
}
