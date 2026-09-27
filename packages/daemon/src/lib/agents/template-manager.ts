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
import {
  runCreateTemplate,
  runDeleteTemplate,
  runHideBuiltInTemplate,
  runUnhideBuiltInTemplate,
  runUpdateTemplate,
} from './template-pipelines.ts';

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

export function resolveEffectiveSpaceAgentTemplate(
  key: string,
  spaceId: string,
  repo?: Pick<SpaceAgentTemplateRepository, 'getOwned' | 'hiddenBuiltInKeys'>
): SpaceAgentTemplate | null {
  const owned = repo?.getOwned(spaceId, key);
  if (owned) {
    const builtIn = getLongHorizonAgentTemplates().find((template) => template.key === owned.key);
    if (!builtIn) return owned;
    return {
      ...owned,
      suggestedEventSubscriptions: builtIn.suggestedEventSubscriptions,
      reminderDefaults: builtIn.reminderDefaults,
    };
  }
  if (repo?.hiddenBuiltInKeys(spaceId).has(key)) return null;
  return getBuiltInSpaceAgentTemplates().find((template) => template.key === key) ?? null;
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

  private async ensureOwnedOverride(
    spaceId: string,
    key: string
  ): Promise<SpaceAgentResult<number | null>> {
    if (this.repo.getOwned(spaceId, key)) return { ok: true, value: null };
    const builtIn = this.builtIns().find((template) => template.key === key);
    if (!builtIn) return { ok: true, value: null };
    const created = await this.createIn(spaceId, {
      key: builtIn.key,
      handle: builtIn.handle,
      displayName: builtIn.displayName,
      description: builtIn.description,
      instructions: builtIn.instructions,
      suggestedAutonomyLevel: builtIn.suggestedAutonomyLevel,
      model: builtIn.model,
      provider: builtIn.provider,
      modelPool: builtIn.modelPool,
      thinkingLevel: builtIn.thinkingLevel,
      settingSources: builtIn.settingSources,
      tools: builtIn.tools,
      labels: builtIn.labels,
    });
    if (!created.ok) return { ok: false, error: created.error };
    return { ok: true, value: created.value.version };
  }

  private discardSeededOverride(spaceId: string, key: string, seededVersion: number | null): void {
    if (seededVersion === null) return;
    const current = this.repo.getOwnedWithVersion(spaceId, key);
    if (current?.version === seededVersion) this.repo.deleteOwned(spaceId, key);
  }

  async updateIn(
    spaceId: string,
    key: string,
    params: UpdateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate | null>> {
    const seeded = await this.ensureOwnedOverride(spaceId, key);
    if (!seeded.ok) return { ok: false, error: seeded.error };
    const { expectedVersion, ...updates } = params;
    const ctx = await runUpdateTemplate({
      repo: this.repo,
      spaceId,
      key,
      params: updates,
      expectedVersion,
    });
    if (ctx.error) {
      this.discardSeededOverride(spaceId, key, seeded.value);
      return { ok: false, error: ctx.error };
    }
    return { ok: true, value: ctx.template ?? null };
  }

  async casUpdateIn(
    spaceId: string,
    key: string,
    params: UpdateSpaceAgentTemplateParams,
    expectedVersion?: number
  ): Promise<SpaceAgentResult<SpaceAgentTemplateRecord | null>> {
    const seeded = await this.ensureOwnedOverride(spaceId, key);
    if (!seeded.ok) return { ok: false, error: seeded.error };
    const ctx = await runUpdateTemplate({
      repo: this.repo,
      spaceId,
      key,
      params,
      expectedVersion,
    });
    if (ctx.error) {
      this.discardSeededOverride(spaceId, key, seeded.value);
      return { ok: false, error: ctx.error };
    }
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

  hideBuiltInIn(spaceId: string, key: string): SpaceAgentResult<void> {
    const ctx = runHideBuiltInTemplate({
      repo: this.repo,
      spaceId,
      key,
      builtIns: this.builtIns(),
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: undefined };
  }

  unhideBuiltInIn(spaceId: string, key: string): SpaceAgentResult<void> {
    const ctx = runUnhideBuiltInTemplate({
      repo: this.repo,
      spaceId,
      key,
      builtIns: this.builtIns(),
    });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: undefined };
  }

  hiddenBuiltInsIn(spaceId: string): SpaceAgentTemplate[] {
    const hidden = this.repo.hiddenBuiltInKeys(spaceId);
    if (hidden.size === 0) return [];
    return this.builtIns().filter((template) => hidden.has(template.key));
  }

  listIn(spaceId: string): SpaceAgentTemplate[] {
    const hidden = this.repo.hiddenBuiltInKeys(spaceId);
    const byKey = new Map<string, SpaceAgentTemplate>();
    for (const template of this.builtIns()) {
      if (isReservedAgentHandle(template.handle)) continue;
      if (hidden.has(template.key)) continue;
      byKey.set(template.key, template);
    }
    for (const template of this.repo.listOwned(spaceId)) {
      byKey.set(template.key, template);
    }
    return [...byKey.values()];
  }

  getIn(spaceId: string, key: string): SpaceAgentTemplate | null {
    const owned = this.repo.getOwned(spaceId, key);
    if (owned) return owned;
    if (this.repo.hiddenBuiltInKeys(spaceId).has(key)) return null;
    return this.builtIns().find((template) => template.key === key) ?? null;
  }
}
