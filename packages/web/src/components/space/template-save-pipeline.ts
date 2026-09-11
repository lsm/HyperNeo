import type {
  AgentModelPoolEntry,
  SettingSource,
  SpaceAgentAutonomyLevel,
  SpaceLongHorizonAgentTemplate,
  ThinkingLevel,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { spaceStore } from '../../lib/space-store';
import type { ModelPoolEditorMode } from './ModelPoolEditor';

export interface TemplateSaveForm {
  displayName: string;
  key: string;
  handle: string;
  description: string;
  instructions: string;
  suggestedAutonomyLevel: number;
  tools: string[];
  pendingTool: string;
  model: string | null;
  provider: string | null;
  modelMode: ModelPoolEditorMode;
  initialModelMode: ModelPoolEditorMode;
  poolEdited: boolean;
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
  const modeSwitched =
    form.modelMode !== form.initialModelMode || (form.poolEdited && form.modelMode === 'pool');
  const effectiveModel = form.modelMode === 'single' || !modeSwitched ? form.model : '';
  const cleanedModelPool = form.modelPool
    .map((entry) => ({ ...entry, model: entry.model.trim() }))
    .filter((entry) => entry.model.length > 0);
  const activeModelPool =
    (form.modelMode === 'pool' || !modeSwitched) && cleanedModelPool.length > 0
      ? cleanedModelPool
      : null;
  const fields = {
    handle: form.handle.trim(),
    displayName: form.displayName.trim(),
    description: form.description.trim(),
    instructions: ctx.template ? form.instructions : form.instructions.trim(),
    suggestedAutonomyLevel: form.suggestedAutonomyLevel as SpaceAgentAutonomyLevel,
    tools: parsedTools,
    model: effectiveModel || null,
    provider: form.provider,
    modelPool: activeModelPool,
    thinkingLevel: form.thinkingLevel,
    settingSources: form.settingSources,
  };
  if (ctx.template) {
    const { model, provider, modelPool, ...rest } = fields;
    const modelConfigUnchanged =
      (effectiveModel || null) === (ctx.template.model ?? null) &&
      (form.provider ?? null) === (ctx.template.provider ?? null) &&
      JSON.stringify(activeModelPool ?? null) === JSON.stringify(ctx.template.modelPool ?? null);
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
