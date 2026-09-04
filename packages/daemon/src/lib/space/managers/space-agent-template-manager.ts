import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  UpdateSpaceAgentTemplateParams,
} from '@hyperneo/shared';
import type { SpaceAgentTemplateRepository } from '../../../storage/repositories/space-agent-template-repository.ts';
import { getLongHorizonAgentTemplates } from '../agents/long-horizon-agent-templates.ts';
import { validateSlug } from '../slug.ts';
import {
  SpaceAgentResult,
  validateAgentModel,
  validateAgentModelPool,
  validateSpaceAgentTools,
} from './space-agent-manager.ts';

type BuiltInTemplateSource = () => SpaceAgentTemplate[];

const MIN_AUTONOMY: SpaceAgentAutonomyLevel = 1;
const MAX_AUTONOMY: SpaceAgentAutonomyLevel = 5;

function getBuiltInSpaceAgentTemplates(): SpaceAgentTemplate[] {
  return getLongHorizonAgentTemplates().map((template) => ({
    key: template.key,
    handle: template.handle,
    displayName: template.displayName,
    description: template.description,
    instructions: template.instructions,
    suggestedAutonomyLevel: template.suggestedAutonomyLevel,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    createdAt: 0,
    updatedAt: 0,
  }));
}

export class SpaceAgentTemplateManager {
  constructor(
    private repo: SpaceAgentTemplateRepository,
    private builtIns: BuiltInTemplateSource = getBuiltInSpaceAgentTemplates
  ) {}

  async create(
    params: CreateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate>> {
    const keyError = validateTemplateKey(params.key);
    if (keyError) return { ok: false, error: keyError };

    const handleError = validateTemplateHandle(params.handle);
    if (handleError) return { ok: false, error: handleError };

    const autonomyError = validateAutonomyLevel(params.suggestedAutonomyLevel);
    if (autonomyError) return { ok: false, error: autonomyError };

    if (params.tools !== undefined && params.tools !== null) {
      const toolError = validateSpaceAgentTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model !== undefined && params.model !== null) {
      const modelError = await validateAgentModel(params.model, params.provider);
      if (modelError) return { ok: false, error: modelError };
    }

    if (params.modelPool !== undefined && params.modelPool !== null) {
      const poolError = await validateAgentModelPool(params.modelPool);
      if (poolError) return { ok: false, error: poolError };
    }

    if (this.repo.getByKey(params.key)) {
      return { ok: false, error: `Template key already exists: ${params.key}` };
    }

    const template = this.repo.create(params);
    return { ok: true, value: template };
  }

  async update(
    key: string,
    params: UpdateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate | null>> {
    const existing = this.repo.getByKey(key);
    if (!existing) return { ok: false, error: `Template not found: ${key}` };

    if (params.handle !== undefined) {
      const handleError = validateTemplateHandle(params.handle);
      if (handleError) return { ok: false, error: handleError };
    }

    if (params.suggestedAutonomyLevel !== undefined) {
      const autonomyError = validateAutonomyLevel(params.suggestedAutonomyLevel);
      if (autonomyError) return { ok: false, error: autonomyError };
    }

    if (params.tools !== undefined && params.tools !== null) {
      const toolError = validateSpaceAgentTools(params.tools);
      if (toolError) return { ok: false, error: toolError };
    }

    if (params.model !== undefined && params.model !== null) {
      const provider =
        params.provider !== undefined
          ? (params.provider ?? undefined)
          : (existing.provider ?? undefined);
      const modelError = await validateAgentModel(params.model, provider);
      if (modelError) return { ok: false, error: modelError };
    }

    if (params.modelPool !== undefined && params.modelPool !== null) {
      const poolError = await validateAgentModelPool(params.modelPool);
      if (poolError) return { ok: false, error: poolError };
    }

    const updated = this.repo.update(key, params);
    if (!updated) return { ok: false, error: `Template not found after update: ${key}` };
    return { ok: true, value: updated };
  }

  delete(key: string): SpaceAgentResult<void> {
    if (!this.repo.getByKey(key)) {
      return { ok: false, error: `Template not found: ${key}` };
    }
    this.repo.delete(key);
    return { ok: true, value: undefined };
  }

  list(): SpaceAgentTemplate[] {
    const byKey = new Map<string, SpaceAgentTemplate>();
    for (const template of this.builtIns()) byKey.set(template.key, template);
    for (const template of this.repo.list()) byKey.set(template.key, template);
    return [...byKey.values()].sort(compareByCreatedAtAndKey);
  }

  getByKey(key: string): SpaceAgentTemplate | null {
    return (
      this.repo.getByKey(key) ?? this.builtIns().find((template) => template.key === key) ?? null
    );
  }
}

function validateTemplateKey(key: string): string | null {
  if (!key || key.trim() !== key) {
    return 'Template key cannot be empty or have leading/trailing whitespace';
  }
  return null;
}

function validateTemplateHandle(handle: string): string | null {
  const trimmed = handle.trim();
  if (trimmed !== handle) return 'Template handle must not have leading or trailing whitespace';
  const slugError = validateSlug(trimmed);
  return slugError ? `Invalid template handle: ${slugError}` : null;
}

function validateAutonomyLevel(level: SpaceAgentAutonomyLevel | undefined): string | null {
  if (level === undefined) return null;
  if (!Number.isInteger(level) || level < MIN_AUTONOMY || level > MAX_AUTONOMY) {
    return `Suggested autonomy level must be an integer between ${MIN_AUTONOMY} and ${MAX_AUTONOMY}`;
  }
  return null;
}

function compareByCreatedAtAndKey(a: SpaceAgentTemplate, b: SpaceAgentTemplate): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.key.localeCompare(b.key);
}
