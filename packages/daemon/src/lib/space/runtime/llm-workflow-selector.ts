import { WORKFLOW_SELECTOR_INSTRUCTIONS } from '@hyperneo/prompts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { getProviderService } from '../../provider-service.ts';
import { resolveSDKCliPath, isRunningUnderBun } from '../../agent/sdk-cli-resolver.ts';
import { mergeProviderEnvVars } from '../../provider-service.ts';
import { KimiProvider } from '../../providers/kimi-provider.js';
import { Logger } from '../../logger.ts';
import { withSdkTranscriptRetention } from '../../agent/sdk-transcript-retention.ts';

const log = new Logger('llm-workflow-selector');

const MAX_TASK_INPUT_CHARS = 1000;
const MAX_WORKFLOW_DESC_CHARS = 240;

export type SelectWorkflowWithLlm = (
  task: SpaceTask,
  workflows: SpaceWorkflow[]
) => Promise<string | null>;

export async function selectWorkflowWithLlmDefault(
  task: SpaceTask,
  workflows: SpaceWorkflow[]
): Promise<string | null> {
  if (workflows.length === 0) return null;
  if (workflows.length === 1) return workflows[0].id;

  const providerService = getProviderService();
  let provider: string;
  try {
    provider = await providerService.getDefaultProvider();
  } catch (err) {
    log.warn('Failed to resolve default provider for workflow selection:', err);
    return null;
  }

  let modelId: string;
  try {
    const cfg = await providerService.getTitleGenerationConfig(provider);
    if (!cfg) {
      log.warn('Default provider has no visible models for workflow selection');
      return null;
    }
    modelId = cfg.modelId;
  } catch (err) {
    log.warn('Failed to resolve title-generation model for workflow selection:', err);
    return null;
  }

  const prompt = buildSelectionPrompt(task, workflows);

  let originalEnv: Awaited<ReturnType<typeof providerService.applyEnvVarsToProcessForProvider>>;
  try {
    originalEnv = await providerService.applyEnvVarsToProcessForProvider(provider, modelId);
  } catch (err) {
    log.warn('Failed to apply provider env vars for workflow selection:', err);
    return null;
  }

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const providerEnvVars = await providerService.getEnvVarsForModel(modelId, provider);
    const mergedEnv = mergeProviderEnvVars(providerEnvVars as Record<string, string | undefined>);
    const cliPath = resolveSDKCliPath();

    providerService.restoreEnvVars(originalEnv);
    originalEnv = {};

    const agentQuery = query({
      prompt,
      options: {
        model: provider === 'glm' ? 'haiku' : modelId,
        maxTurns: 1,
        permissionMode: 'acceptEdits',
        allowDangerouslySkipPermissions: false,
        mcpServers: {},
        settingSources: [],
        tools: [],
        pathToClaudeCodeExecutable: cliPath,
        executable: isRunningUnderBun() ? 'bun' : undefined,
        settings: withSdkTranscriptRetention(),
        env: mergedEnv,
        thinking:
          provider === 'kimi'
            ? KimiProvider.resolveKimiTitleThinkingConfig(modelId)
            : { type: 'disabled' },
      },
    });

    const { isSDKAssistantMessage } = await import('@hyperneo/shared/sdk/type-guards');
    let raw = '';
    for await (const message of agentQuery) {
      if (isSDKAssistantMessage(message)) {
        const textBlocks = message.message.content.filter(
          (b: { type: string }) => b.type === 'text'
        ) as Array<{ text?: string }>;
        raw = textBlocks
          .map((b) => b.text ?? '')
          .join(' ')
          .trim();
        if (raw) break;
      }
    }

    if (!raw) return null;

    const cleaned = cleanIdResponse(raw);
    if (!cleaned) return null;

    const hit = workflows.find((w) => w.id === cleaned);
    return hit ? hit.id : null;
  } catch (err) {
    log.warn('LLM workflow selection failed:', err);
    return null;
  } finally {
    try {
      providerService.restoreEnvVars(originalEnv);
    } catch {}
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function buildSelectionPrompt(task: SpaceTask, workflows: SpaceWorkflow[]): string {
  const title = truncate(task.title ?? '', MAX_TASK_INPUT_CHARS);
  const description = truncate(task.description ?? '', MAX_TASK_INPUT_CHARS);
  const taskBlock = `Task title: ${title}\nTask description: ${description || '(empty)'}`;

  const list = workflows
    .map((w) => {
      const name = truncate(w.name ?? '(unnamed)', 120);
      const desc = truncate(w.description ?? '', MAX_WORKFLOW_DESC_CHARS) || '(no description)';
      const tags = (w.tags ?? []).slice(0, 8).join(', ') || '(none)';
      return `- id: ${w.id}\n  name: ${name}\n  description: ${desc}\n  tags: ${tags}`;
    })
    .join('\n');

  return `You are selecting the best workflow to execute a task.

${taskBlock}

Candidate workflows:
${list}

Instructions:\n${WORKFLOW_SELECTOR_INSTRUCTIONS}`;
}

function cleanIdResponse(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(/^[`"']+|[`"']+$/g, '').trim();
  if (/[\s:]/.test(value)) {
    const tokens = value.split(/[\s:]+/).filter(Boolean);
    if (tokens.length > 0) value = tokens[tokens.length - 1];
  }
  if (!value || value.toLowerCase() === 'none') return null;
  return value;
}
