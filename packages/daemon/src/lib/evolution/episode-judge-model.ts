import type { EvolutionScope } from '@hyperneo/shared';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { runOneShotModel } from '../agent/one-shot-model.ts';
import { Logger } from '../logger.ts';
import { getProviderService } from '../provider-service.ts';
import { getAvailableModels } from '../model-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import type { EpisodeJudgeOutput, EpisodeJudgePromptInput } from './episode-service-types.ts';
import { buildEpisodeJudgePrompt } from './episode-judge-prompt.ts';
import { parseEpisodeJudgeJson } from './episode-judge-output.ts';

const log = new Logger('evolution-episode-service');

export async function resolveEpisodeJudgeModel(
  input: EpisodeJudgePromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<{ provider: string; modelId: string }> {
  const scopeModel = readEpisodeJudgeModel(input.scope);
  const scopeProvider = scopeModel ? readEpisodeJudgeProvider(input.scope) : undefined;
  const spaceModel = scopeModel
    ? undefined
    : spaceRepo?.getSpace(input.scope.spaceId)?.defaultModel;
  const selectedModel = scopeModel ?? spaceModel?.trim();
  if (selectedModel) {
    const cachedModel = findCachedModel(selectedModel, scopeProvider);
    return {
      provider: scopeProvider ?? cachedModel?.provider ?? inferProviderForModel(selectedModel),
      modelId: cachedModel?.id ?? selectedModel,
    };
  }
  const providerService = getProviderService();
  const provider = await providerService.getDefaultProvider();
  const cfg = await providerService.getTitleGenerationConfig(provider);
  if (!cfg) {
    throw new Error(`Provider ${provider} has no visible models for episode judging`);
  }
  return { provider, modelId: cfg.modelId };
}

function readEpisodeJudgeModel(scope: EvolutionScope): string | undefined {
  const value = scope.policy.episodeJudgeModel;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readEpisodeJudgeProvider(scope: EvolutionScope): string | undefined {
  const value = scope.policy.episodeJudgeProvider;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findCachedModel(
  modelId: string,
  provider?: string
): { id: string; provider: string } | undefined {
  const models = getAvailableModels('global');
  const providerMatches = provider ? models.filter((model) => model.provider === provider) : models;
  return (
    providerMatches.find((model) => model.id === modelId) ??
    providerMatches.find((model) => model.alias === modelId)
  );
}

export async function judgeEpisodeWithModel(
  input: EpisodeJudgePromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<EpisodeJudgeOutput> {
  const providerService = getProviderService();
  const { provider, modelId } = await resolveEpisodeJudgeModel(input, spaceRepo);
  const prompt = buildEpisodeJudgePrompt(input);
  try {
    const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
      string,
      string | undefined
    >;
    const sdkModelId = provider === 'glm' ? 'haiku' : (providerEnvVars.ANTHROPIC_MODEL ?? modelId);
    const raw = await runOneShotModel({
      prompt,
      provider,
      model: sdkModelId,
      thinkingModelId: sdkModelId,
      env: await providerService.getIsolatedEnvForModel(provider, modelId),
      separator: '\n',
    });
    if (!raw) throw new Error('Episode judge returned no text');
    return parseEpisodeJudgeJson(raw);
  } catch (err) {
    log.warn('Episode judge model call failed:', err);
    throw err;
  }
}
