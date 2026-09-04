import type {
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  UpdateSpaceLongHorizonAgentParams,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../agents/worker-long-horizon-mapper.ts';
import type { SpaceAgentResult } from './space-agent-manager.ts';

export interface ReapplyTemplateAgentSource {
  getById(id: string): SpaceLongHorizonAgent | null;
  update(id: string, params: UpdateSpaceLongHorizonAgentParams): SpaceLongHorizonAgent | null;
}

export interface ReapplyTemplateTemplateSource {
  getByKey(key: string): SpaceAgentTemplate | null;
}

export interface ReapplyTemplateCtx {
  agents: ReapplyTemplateAgentSource;
  templates: ReapplyTemplateTemplateSource;
  agentId: string;
  error?: string;
  agent?: SpaceLongHorizonAgent;
  template?: SpaceAgentTemplate;
  updated?: SpaceLongHorizonAgent;
}

export function templateToAgentUpdateParams(
  template: SpaceAgentTemplate
): UpdateSpaceLongHorizonAgentParams {
  return {
    instructions: template.instructions,
    model: template.model,
    provider: template.provider,
    modelPool: template.modelPool,
    thinkingLevel: template.thinkingLevel,
    settingSources: template.settingSources,
    toolPermissions:
      template.tools && template.tools.length > 0 ? { tools: [...template.tools] } : {},
  };
}

function reapplyLoadAgent(ctx: ReapplyTemplateCtx): ReapplyTemplateCtx {
  const agent = ctx.agents.getById(ctx.agentId);
  if (!agent) return { ...ctx, error: `Agent not found: ${ctx.agentId}` };
  return { ...ctx, agent };
}

function reapplyCheckMirrorLock(ctx: ReapplyTemplateCtx): ReapplyTemplateCtx {
  if (ctx.agent?.templateKey !== MIGRATED_WORKER_TEMPLATE_KEY) return ctx;
  return {
    ...ctx,
    error:
      `Agent ${ctx.agentId} is a migrated worker mirror — edit the worker agent instead; ` +
      'worker edits propagate to the mirror.',
  };
}

function reapplyResolveTemplate(ctx: ReapplyTemplateCtx): ReapplyTemplateCtx {
  const templateKey = ctx.agent?.templateKey ?? null;
  if (!templateKey) return { ...ctx, error: `Agent ${ctx.agentId} has no template to re-apply` };
  const template = ctx.templates.getByKey(templateKey);
  if (!template) return { ...ctx, error: `Template not found: ${templateKey}` };
  return { ...ctx, template };
}

function reapplyPersist(ctx: ReapplyTemplateCtx): ReapplyTemplateCtx {
  if (ctx.template === undefined) return ctx;
  try {
    const updated = ctx.agents.update(ctx.agentId, templateToAgentUpdateParams(ctx.template));
    if (!updated) return { ...ctx, error: `Agent not found after re-apply: ${ctx.agentId}` };
    return { ...ctx, updated };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ...ctx, error: `Failed to re-apply template: ${detail}` };
  }
}

const reapplyTemplatePipeline = superpipe({
  hasError: (ctx: { error?: string }) => ctx.error !== undefined,
});

export const runReapplyTemplate = (
  reapplyTemplatePipeline('reapply-space-agent-template') as PipelineAPI
)
  .input(['ctx'])
  .pipe(reapplyLoadAgent, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(reapplyCheckMirrorLock, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(reapplyResolveTemplate, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(reapplyPersist, 'ctx', 'ctx')
  .end('ctx') as (input: ReapplyTemplateCtx) => ReapplyTemplateCtx;

export class SpaceAgentTemplateReapplyService {
  constructor(
    private agents: ReapplyTemplateAgentSource,
    private templates: ReapplyTemplateTemplateSource
  ) {}

  reapplyTemplate(agentId: string): SpaceAgentResult<SpaceLongHorizonAgent> {
    const ctx = runReapplyTemplate({
      agents: this.agents,
      templates: this.templates,
      agentId,
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: ctx.updated! };
  }
}
