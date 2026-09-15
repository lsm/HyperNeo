import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentTemplate,
  UpdateSpaceAgentTemplateParams,
} from '@hyperneo/shared';
import type {
  SpaceAgentTemplateRecord,
  SpaceAgentTemplateRepository,
} from '../../storage/repositories/space-agent-template-repository.ts';
import { isReservedAgentHandle } from '../messaging/agent-handle.ts';
import type { SpaceAgentResult } from './validation.ts';
import { getLongHorizonAgentTemplates } from './long-horizon-templates.ts';
import type { TemplateInstanceScan } from './template-pipelines.ts';
import { runCreateTemplate, runDeleteTemplate, runUpdateTemplate } from './template-pipelines.ts';

export type {
  CreateTemplateCtx,
  DeleteTemplateCtx,
  TemplateInstanceScan,
  UpdateTemplateCtx,
} from './template-pipelines.ts';
export { runCreateTemplate, runDeleteTemplate, runUpdateTemplate } from './template-pipelines.ts';

type BuiltInTemplateSource = () => SpaceAgentTemplate[];

export function getBuiltInSpaceAgentTemplates(): SpaceAgentTemplate[] {
  return getLongHorizonAgentTemplates().map((template) => {
    const presetTools = template.toolPermissions.tools;
    return {
      key: template.key,
      handle: template.handle,
      displayName: template.displayName,
      description: template.description,
      instructions: template.instructions,
      suggestedAutonomyLevel: template.suggestedAutonomyLevel,
      suggestedEventSubscriptions: template.suggestedEventSubscriptions,
      reminderDefaults: template.reminderDefaults,
      model: null,
      provider: null,
      modelPool: null,
      thinkingLevel: null,
      settingSources: null,
      tools: Array.isArray(presetTools)
        ? presetTools.filter((tool): tool is string => typeof tool === 'string')
        : null,
      labels: template.labels ?? [],
      createdAt: 0,
      updatedAt: 0,
    };
  });
}

export class SpaceAgentTemplateManager {
  constructor(
    private repo: SpaceAgentTemplateRepository,
    private builtIns: BuiltInTemplateSource = getBuiltInSpaceAgentTemplates,
    private instanceScan?: TemplateInstanceScan
  ) {}

  async createIn(
    spaceId: string,
    params: CreateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplateRecord>> {
    const ctx = await runCreateTemplate({ repo: this.repo, spaceId, params });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: this.repo.getOwnedWithVersion(spaceId, ctx.params.key)! };
  }

  async updateIn(
    spaceId: string,
    key: string,
    params: UpdateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate | null>> {
    const { expectedVersion, ...updates } = params;
    const ctx = await runUpdateTemplate({
      repo: this.repo,
      spaceId,
      key,
      params: updates,
      expectedVersion,
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: ctx.template ?? null };
  }

  async casUpdateIn(
    spaceId: string,
    key: string,
    params: UpdateSpaceAgentTemplateParams,
    expectedVersion?: number
  ): Promise<SpaceAgentResult<SpaceAgentTemplateRecord | null>> {
    const ctx = await runUpdateTemplate({
      repo: this.repo,
      spaceId,
      key,
      params,
      expectedVersion,
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    if (!ctx.template) return { ok: true, value: null };
    return { ok: true, value: ctx.template as SpaceAgentTemplateRecord };
  }

  deleteIn(spaceId: string, key: string, expectedVersion?: number): SpaceAgentResult<void> {
    if (
      !this.repo.getOwned(spaceId, key) &&
      this.builtIns().some((template) => template.key === key)
    ) {
      return { ok: false, error: `Built-in template "${key}" cannot be deleted` };
    }
    const ctx = runDeleteTemplate({
      repo: this.repo,
      spaceId,
      key,
      expectedVersion,
      instanceScan: this.instanceScan,
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: undefined };
  }

  listIn(spaceId: string): SpaceAgentTemplate[] {
    const byKey = new Map<string, SpaceAgentTemplate>();
    for (const template of this.builtIns()) {
      if (isReservedAgentHandle(template.handle)) continue;
      byKey.set(template.key, template);
    }
    const builtIns = [...byKey.values()];
    const owned = this.repo.listOwned(spaceId).filter((template) => !byKey.has(template.key));
    return [...builtIns, ...owned];
  }

  getIn(spaceId: string, key: string): SpaceAgentTemplate | null {
    return (
      this.builtIns().find((template) => template.key === key) ??
      this.repo.getOwned(spaceId, key) ??
      null
    );
  }
}
