import { EVOLUTION_CONVERSATION_FRICTION_PROMPT, fillPrompt } from '@hyperneo/prompts';
import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { oneShotModelIds, runOneShotModel } from '../agent/one-shot-model.ts';
import { getAvailableModels } from '../model-service.ts';
import { getProviderService } from '../provider-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import type {
  ConversationFrictionAnalysis,
  ConversationFrictionPromptInput,
} from './conversation-analysis-types.ts';
import { parseConversationFrictionJson } from './conversation-analysis-parsing.ts';

export function buildConversationFrictionPrompt(input: ConversationFrictionPromptInput): string {
  const transcript = input.messages
    .map(
      (message, index) =>
        `[${index + 1}] id=${message.metadata.messageId} role=${message.role} session=${message.metadata.sessionId}\n${message.text}`
    )
    .join('\n\n');
  return fillPrompt(EVOLUTION_CONVERSATION_FRICTION_PROMPT, {
    confidence_threshold: String(input.confidenceThreshold),
    task_title: input.task.title,
    task_description: input.task.description,
    scope_name: input.scope.name,
    scope_objective: input.scope.objective,
    transcript,
  });
}

export async function analyzeConversationWithModel(
  input: ConversationFrictionPromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<ConversationFrictionAnalysis> {
  const providerService = getProviderService();
  const { provider, modelId } = await resolveConversationFrictionModel(input, spaceRepo);
  const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
    string,
    string | undefined
  >;
  const raw = await runOneShotModel({
    prompt: buildConversationFrictionPrompt(input),
    provider,
    ...oneShotModelIds(provider, modelId, providerEnvVars),
    env: await providerService.getIsolatedEnvForModel(provider, modelId),
    separator: '\n',
  });
  if (!raw) throw new Error('Conversation friction analyzer returned no text');
  return parseConversationFrictionJson(raw);
}

async function resolveConversationFrictionModel(
  input: ConversationFrictionPromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<{ provider: string; modelId: string }> {
  const spaceModel = spaceRepo?.getSpace(input.scope.spaceId)?.defaultModel?.trim();
  if (spaceModel) {
    const cachedModel = findCachedModel(spaceModel);
    return {
      provider: cachedModel?.provider ?? inferProviderForModel(spaceModel),
      modelId: cachedModel?.id ?? spaceModel,
    };
  }
  const providerService = getProviderService();
  const provider = await providerService.getDefaultProvider();
  const cfg = await providerService.getTitleGenerationConfig(provider);
  if (!cfg) {
    throw new Error(`Provider ${provider} has no visible models for conversation analysis`);
  }
  return { provider, modelId: cfg.modelId };
}

function findCachedModel(modelId: string): { id: string; provider: string } | undefined {
  const models = getAvailableModels('global');
  return (
    models.find((model) => model.id === modelId) ?? models.find((model) => model.alias === modelId)
  );
}
