import type { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { isRunningUnderBun, resolveSDKCliPath } from '../agent/sdk-cli-resolver.ts';
import { getAvailableModels } from '../model-service.ts';
import { getProviderService, mergeProviderEnvVars } from '../provider-service.ts';
import { inferProviderForModel } from '../providers/registry.ts';
import { KimiProvider } from '../providers/kimi-provider.js';
import { withSdkTranscriptRetention } from '../agent/sdk-transcript-retention.ts';
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
  return `Analyze this task conversation for conversation friction patterns that rule-based tool analysis cannot detect.

Return only JSON matching this TypeScript shape:
{
  "patterns": [{
    "kind": "human_correction" | "human_repetition" | "agent_misunderstanding" | "scope_creep" | "requirement_confusion" | "agent_apology" | "synthetic_interruption",
    "confidence": number,
    "summary": string,
    "involvedMessages": string[],
    "severity": "low" | "medium" | "high"
  }],
  "humanInterventionCount": number,
  "syntheticInterventionCount": number,
  "agentUncertaintyCount": number,
  "overallAssessment": string
}

Rules:
- Use only supplied message ids in involvedMessages.
- Focus on actionable struggle patterns, miscommunications, repeated corrections, interruptions, uncertainty, apologies, or scope drift.
- Do not report ordinary tool failures or test failures unless conversation text shows misunderstanding or friction.
- Include only patterns with confidence >= ${input.confidenceThreshold}.
- Keep summaries concise and actionable.

Task: ${input.task.title}
Task description: ${input.task.description}
Scope: ${input.scope.name} — ${input.scope.objective}

Transcript:
${transcript}`;
}

export async function analyzeConversationWithModel(
  input: ConversationFrictionPromptInput,
  spaceRepo?: Pick<SpaceRepository, 'getSpace'>
): Promise<ConversationFrictionAnalysis> {
  const providerService = getProviderService();
  const { provider, modelId } = await resolveConversationFrictionModel(input, spaceRepo);
  let originalEnv = await providerService.applyEnvVarsToProcessForProvider(provider, modelId);
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
      string,
      string | undefined
    >;
    const sdkModelId = provider === 'glm' ? 'haiku' : (providerEnvVars.ANTHROPIC_MODEL ?? modelId);
    const mergedEnv = mergeProviderEnvVars(providerEnvVars);
    providerService.restoreEnvVars(originalEnv);
    originalEnv = {};
    const agentQuery = query({
      prompt: buildConversationFrictionPrompt(input),
      options: {
        model: sdkModelId,
        maxTurns: 1,
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: resolveSDKCliPath(),
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: mergedEnv,
        thinking:
          provider === 'kimi'
            ? KimiProvider.resolveKimiTitleThinkingConfig(sdkModelId)
            : { type: 'disabled' },
      },
    });
    let raw = '';
    for await (const message of agentQuery) {
      if (isSDKAssistantMessage(message)) {
        const textBlocks = message.message.content.filter(
          (block: { type: string }) => block.type === 'text'
        ) as Array<{ text?: string }>;
        raw = textBlocks
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        if (raw) break;
      }
    }
    if (!raw) throw new Error('Conversation friction analyzer returned no text');
    return parseConversationFrictionJson(raw);
  } finally {
    providerService.restoreEnvVars(originalEnv);
  }
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
