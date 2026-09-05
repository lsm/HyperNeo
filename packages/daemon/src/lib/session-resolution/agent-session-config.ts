import type { AgentDefinition, Session, Space, SpaceLongHorizonAgent } from '@hyperneo/shared';
import { isScopedBashToolEntry } from '@hyperneo/shared';
import { findInModels, getAvailableModels } from '../model-service.ts';
import { inferPersistableProviderForModel } from '../providers/registry.ts';
import {
  LONG_HORIZON_AGENT_BUILTIN_TOOLS,
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
} from '../space/agents/long-horizon-agent-tools.ts';
import { deriveWorkerDisallowedTools } from '../space/agents/tool-policy.ts';

const LONG_TERM_AGENT_SESSION_FEATURES = {
  rewind: false,
  worktree: false,
  coordinator: false,
  archive: false,
  sessionInfo: false,
} as const;

const DEFAULT_LONG_HORIZON_AGENT_MODEL = 'claude-sonnet-4-6';

export interface AgentSessionConfigInput {
  agent: SpaceLongHorizonAgent;
}

export interface AgentSessionConfigCurrent {
  provider?: string;
  model?: string;
}

export async function buildAgentSessionConfig(
  input: AgentSessionConfigInput,
  space: Space,
  currentConfig?: AgentSessionConfigCurrent
): Promise<Partial<Session['config']>> {
  const customTools = agentCustomTools(input);
  const customDisallowedBuiltins = deriveWorkerDisallowedTools(customTools);
  const scopedBashToolEntries = customTools?.filter((tool) => isScopedBashToolEntry(tool));
  const agentKey = sanitizeLongTermAgentKey(input.agent.displayName);
  const model =
    input.agent.model ??
    space.defaultModel ??
    (input.agent.provider ? undefined : DEFAULT_LONG_HORIZON_AGENT_MODEL);
  const provider = (input.agent.provider ??
    (model
      ? await resolveAgentConfigProvider(model, currentConfig?.provider, currentConfig?.model)
      : undefined)) as Session['config']['provider'];
  const promptValues = agentPromptValues(input);
  return {
    model,
    provider,
    thinkingLevel: input.agent.thinkingLevel ?? undefined,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: promptValues.append,
    },
    sdkToolsPreset: [...LONG_HORIZON_AGENT_BUILTIN_TOOLS],
    features: LONG_TERM_AGENT_SESSION_FEATURES,
    allowedTools:
      scopedBashToolEntries && scopedBashToolEntries.length > 0 ? scopedBashToolEntries : undefined,
    disallowedTools: customDisallowedBuiltins.length > 0 ? customDisallowedBuiltins : undefined,
    agent: customDisallowedBuiltins.length > 0 ? agentKey : undefined,
    agents:
      customDisallowedBuiltins.length > 0
        ? {
            [agentKey]: {
              description: promptValues.description,
              disallowedTools: customDisallowedBuiltins,
              model: 'inherit',
              prompt: promptValues.prompt,
            } satisfies AgentDefinition,
          }
        : undefined,
    settingSources: input.agent.settingSources ?? space.settingSources,
  };
}

function agentCustomTools(input: AgentSessionConfigInput): string[] | undefined {
  return Array.isArray(input.agent.toolPermissions.tools)
    ? (input.agent.toolPermissions.tools.filter((tool) => typeof tool === 'string') as string[])
    : undefined;
}

function agentPromptValues(input: AgentSessionConfigInput): {
  append: string;
  prompt: string;
  description: string;
} {
  const instructions = input.agent.instructions?.trim();
  return {
    append: instructions
      ? `${instructions}\n\n${LONG_HORIZON_OWNER_REVIEW_CONTRACT}\n\n${LONG_HORIZON_SCHEDULING_GUARDRAIL}`
      : `${LONG_HORIZON_OWNER_REVIEW_CONTRACT}\n\n${LONG_HORIZON_SCHEDULING_GUARDRAIL}`,
    prompt: input.agent.instructions,
    description: `Long-horizon Space agent: ${input.agent.displayName}`,
  };
}

function sanitizeLongTermAgentKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'space-agent'
  );
}

async function resolveAgentConfigProvider(
  model: string,
  preferredProvider?: string,
  currentModel?: string
): Promise<Session['config']['provider']> {
  const models = getAvailableModels('global');
  if (preferredProvider) {
    if (currentModel && model === currentModel) {
      return preferredProvider as Session['config']['provider'];
    }
    const stillOffered = findInModels(
      models.filter((m) => m.provider === preferredProvider),
      model
    );
    if (stillOffered) return preferredProvider as Session['config']['provider'];
  }
  const cached = findInModels(models, model);
  if (cached?.provider) return cached.provider as Session['config']['provider'];
  return (await inferPersistableProviderForModel(model)) as Session['config']['provider'];
}
