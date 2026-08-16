/**
 * LLM-based workflow selector.
 *
 * Picks the best workflow for a standalone task by asking a small, cheap LLM
 * (haiku tier) to rank a compact description of each available workflow
 * against the task title/description.
 *
 * Design notes:
 * - Returns a workflow ID string from the provided list, or `null` if the LLM
 *   declines/fails. Callers are responsible for the final fallback (e.g. a
 *   `default`-tagged workflow) so this helper can be mocked cleanly in tests.
 * - The helper sets `maxTurns: 1`, disables thinking, and hands the SDK an
 *   empty tool list: we only need a single short text response.
 * - The input prompt is capped at ~1000 chars per task description so a long
 *   task body can't drive up token cost or slow the tick.
 *
 * Intended wire-up: pass `selectWorkflowWithLlm` into `SpaceRuntimeConfig`.
 * The runtime calls the callback from `attachStandaloneTasksToWorkflows()`
 * when more than one workflow is available; callers can swap in a mock in
 * tests without reaching into the SDK.
 */

import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { getProviderService } from '../../provider-service';
import { resolveSDKCliPath, isRunningUnderBun } from '../../agent/sdk-cli-resolver';
import { mergeProviderEnvVars } from '../../provider-service';
import { KimiProvider } from '../../providers/kimi-provider.js';
import { Logger } from '../../logger';
import { withSdkTranscriptRetention } from '../../agent/sdk-transcript-retention';

const log = new Logger('llm-workflow-selector');

/** Maximum characters per field (title + description) sent to the LLM. */
const MAX_TASK_INPUT_CHARS = 1000;
/** Maximum characters per workflow field shown in the candidate list. */
const MAX_WORKFLOW_DESC_CHARS = 240;

/**
 * Callback signature accepted by `SpaceRuntimeConfig.selectWorkflowWithLlm`.
 *
 * Implementations receive the task plus the candidate workflow list and must
 * return either one of the provided workflow IDs or `null` to defer to the
 * deterministic fallback.
 */
export type SelectWorkflowWithLlm = (
  task: SpaceTask,
  workflows: SpaceWorkflow[]
) => Promise<string | null>;

/**
 * Default LLM-driven workflow selector that talks to the Claude Agent SDK.
 *
 * Safe to use as the production implementation when no other callback is
 * provided. Returns `null` on any failure so callers can fall back to a
 * deterministic choice without surfacing errors.
 */
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
        // We only need a short text response; adaptive-thinking models can
        // otherwise return only thinking blocks with no text payload.
        // Kimi K3 rejects `thinking.type` entirely, so omit the field for K3.
        // Kimi K2.7 requires enabled thinking. For all other providers keep the
        // safe disabled-thinking default.
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

    // Match exact ID first; if the LLM echoed `none` or anything outside the
    // candidate set, return null so the caller can pick a deterministic fallback.
    const hit = workflows.find((w) => w.id === cleaned);
    return hit ? hit.id : null;
  } catch (err) {
    log.warn('LLM workflow selection failed:', err);
    return null;
  } finally {
    try {
      providerService.restoreEnvVars(originalEnv);
    } catch {
      /* ignore env restore failures */
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

Instructions:
- Reply with EXACTLY one of the workflow ids above, with no other text.
- If none of the workflows fit the task, reply with the single word: none
- Do NOT wrap the id in quotes, backticks, or markdown.
- Do NOT explain your choice.`;
}

function cleanIdResponse(raw: string): string | null {
  let value = raw.trim();
  // Strip wrapping quotes / backticks if the model ignored the instructions.
  value = value.replace(/^[`"']+|[`"']+$/g, '').trim();
  // If the model prefixed with "id:" or "Workflow:" take the final token.
  if (/[\s:]/.test(value)) {
    const tokens = value.split(/[\s:]+/).filter(Boolean);
    if (tokens.length > 0) value = tokens[tokens.length - 1];
  }
  if (!value || value.toLowerCase() === 'none') return null;
  return value;
}
