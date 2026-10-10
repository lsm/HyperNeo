import {
  fillPrompt,
  WORKFLOW_SELECTION_PROMPT,
  WORKFLOW_SELECTOR_INSTRUCTIONS,
} from '@hyperneo/prompts';
import type { SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { oneShotModelIds, runOneShotModel } from '../agent/one-shot-model.ts';
import { Logger } from '../logger.ts';
import { getProviderService } from '../provider-service.ts';

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

  try {
    const providerEnvVars = (await providerService.getEnvVarsForModel(modelId, provider)) as Record<
      string,
      string | undefined
    >;
    const raw = await runOneShotModel({
      prompt,
      provider,
      ...oneShotModelIds(provider, modelId, providerEnvVars),
      env: await providerService.getIsolatedEnvForModel(provider, modelId),
    });

    if (!raw) return null;

    const cleaned = cleanIdResponse(raw);
    if (!cleaned) return null;

    const hit = workflows.find((w) => w.id === cleaned);
    return hit ? hit.id : null;
  } catch (err) {
    log.warn('LLM workflow selection failed:', err);
    return null;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function buildSelectionPrompt(task: SpaceTask, workflows: SpaceWorkflow[]): string {
  const title = truncate(task.title ?? '', MAX_TASK_INPUT_CHARS);
  const description = truncate(task.description ?? '', MAX_TASK_INPUT_CHARS);

  const list = workflows
    .map((w) => {
      const name = truncate(w.name ?? '(unnamed)', 120);
      const desc = truncate(w.description ?? '', MAX_WORKFLOW_DESC_CHARS) || '(no description)';
      const tags = (w.tags ?? []).slice(0, 8).join(', ') || '(none)';
      return `- id: ${w.id}\n  name: ${name}\n  description: ${desc}\n  tags: ${tags}`;
    })
    .join('\n');

  return fillPrompt(WORKFLOW_SELECTION_PROMPT, {
    title,
    description: description || '(empty)',
    workflows: list,
    instructions: WORKFLOW_SELECTOR_INSTRUCTIONS,
  });
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
