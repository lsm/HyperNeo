import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceAgentAutonomyLevel,
  SpaceLongHorizonAgentTemplate,
  ThinkingLevel,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { spaceStore } from '../../lib/space-store';
import { modelConfigFromPool, sameModelConfig, storedModelConfig } from './agent-model-pool';

export interface TemplateSaveForm {
  displayName: string;
  key: string;
  handle: string;
  description: string;
  instructions: string;
  suggestedAutonomyLevel: number;
  tools: string[];
  pendingTool: string;
  modelPool: AgentModelPoolEntry[];
  thinkingLevel: ThinkingLevel | null;
  settingSources: SettingSource[] | null;
}

export interface TemplateSaveCtx {
  template: SpaceLongHorizonAgentTemplate | null;
  form: TemplateSaveForm;
  parsedTools: string[];
}

function templateSaveValidateStage(ctx: TemplateSaveCtx): TemplateSaveCtx {
  if (!ctx.form.displayName.trim()) throw new Error('Name is required');
  if (!ctx.form.key.trim()) throw new Error('Template key is required');
  if (!ctx.form.handle.trim()) throw new Error('Handle is required');
  return ctx;
}

function templateSaveParseToolsStage(ctx: TemplateSaveCtx): TemplateSaveCtx {
  const pendingTool = ctx.form.pendingTool.trim();
  const parsedTools =
    pendingTool && !ctx.form.tools.includes(pendingTool)
      ? [...ctx.form.tools, pendingTool]
      : ctx.form.tools;
  return { ...ctx, parsedTools };
}

async function templateSavePersistStage(ctx: TemplateSaveCtx): Promise<TemplateSaveCtx> {
  const { form, parsedTools } = ctx;
  const modelConfig = modelConfigFromPool(form.modelPool);
  const fields = {
    handle: form.handle.trim(),
    displayName: form.displayName.trim(),
    description: form.description.trim(),
    instructions: ctx.template ? form.instructions : form.instructions.trim(),
    suggestedAutonomyLevel: form.suggestedAutonomyLevel as SpaceAgentAutonomyLevel,
    tools: parsedTools,
    model: modelConfig.model,
    provider: modelConfig.provider,
    modelPool: modelConfig.modelPool,
    thinkingLevel: modelConfig.thinkingLevel ?? form.thinkingLevel,
    settingSources: form.settingSources,
  };
  if (ctx.template) {
    const { model, provider, modelPool, ...rest } = fields;
    const modelConfigUnchanged = sameModelConfig(modelConfig, storedModelConfig(ctx.template));
    await spaceStore.updateTemplate(
      ctx.template.key,
      modelConfigUnchanged
        ? { ...rest, expectedVersion: ctx.template.version }
        : { ...rest, model, provider, modelPool, expectedVersion: ctx.template.version }
    );
    return ctx;
  }
  await spaceStore.createTemplate({ key: form.key.trim(), ...fields });
  return ctx;
}

export const runTemplateSave = (superpipe({})('save-agent-template') as PipelineAPI)
  .input(['ctx'])
  .pipe(templateSaveValidateStage, 'ctx', 'ctx')
  .pipe(templateSaveParseToolsStage, 'ctx', 'ctx')
  .pipe(templateSavePersistStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: TemplateSaveCtx) => Promise<TemplateSaveCtx>;
