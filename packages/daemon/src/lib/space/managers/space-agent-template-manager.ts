import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  UpdateSpaceAgentTemplateParams,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  SpaceAgentTemplateRecord,
  SpaceAgentTemplateRepository,
} from '../../../storage/repositories/space-agent-template-repository.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../agents/worker-long-horizon-mapper.ts';
import {
  getLongHorizonAgentTemplate,
  getLongHorizonAgentTemplates,
} from '../agents/long-horizon-agent-templates.ts';
import { validateSlug } from '../slug.ts';
import type { SpaceAgentResult } from '../agents/agent-validation.ts';
import {
  validateAgentModel,
  validateAgentModelPool,
  validateSpaceAgentTools,
} from '../agents/agent-validation.ts';

type BuiltInTemplateSource = () => SpaceAgentTemplate[];

const MIN_AUTONOMY: SpaceAgentAutonomyLevel = 1;
const MAX_AUTONOMY: SpaceAgentAutonomyLevel = 5;

export interface CreateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  params: CreateSpaceAgentTemplateParams;
  error?: string;
  template?: SpaceAgentTemplate;
}

export interface UpdateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  key: string;
  params: UpdateSpaceAgentTemplateParams;
  existing?: SpaceAgentTemplateRecord;
  version?: number;
  error?: string;
  template?: SpaceAgentTemplate | null;
}

export interface DeleteTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  key: string;
  existing?: SpaceAgentTemplate;
  error?: string;
  deleted?: boolean;
}

function getBuiltInSpaceAgentTemplates(): SpaceAgentTemplate[] {
  return getLongHorizonAgentTemplates().map((template) => {
    const presetTools = template.toolPermissions.tools;
    return {
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
      tools: Array.isArray(presetTools)
        ? presetTools.filter((tool): tool is string => typeof tool === 'string')
        : null,
      createdAt: 0,
      updatedAt: 0,
    };
  });
}

function validateTemplateKey(key: string): string | null {
  if (!key || key.trim() !== key) {
    return 'Template key cannot be empty or have leading/trailing whitespace';
  }
  if (key === MIGRATED_WORKER_TEMPLATE_KEY) {
    return `Template key "${key}" is reserved`;
  }
  if (getLongHorizonAgentTemplate(key)) {
    return `Template key "${key}" is reserved for a built-in agent template`;
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

function validateDisplayName(displayName: string | undefined | null): string | null {
  if (displayName === undefined || displayName === null) return null;
  if (displayName.trim() === '') return 'Template display name cannot be blank';
  return null;
}

function validateToolsChoice(tools: string[] | null | undefined): string | null {
  if (tools === undefined || tools === null) return null;
  return validateSpaceAgentTools(tools);
}

async function validateModelChoice(
  model: string | null | undefined,
  provider: string | null | undefined
): Promise<string | null> {
  if (provider !== undefined && provider !== null && provider.trim() === '') {
    return 'Provider identifier cannot be blank';
  }
  if (model === undefined || model === null) return null;
  if (model.trim() === '') return 'Model identifier cannot be blank';
  return validateAgentModel(model, provider);
}

async function validateTemplateModelPool(
  pool: WorkerAgentModelPoolEntry[] | null | undefined
): Promise<string | null> {
  if (pool === undefined || pool === null || pool.length === 0) return null;
  for (const entry of pool) {
    if (!entry.model || entry.model.trim() === '') return 'Model pool entries must specify a model';
    if (entry.provider !== undefined && entry.provider.trim() === '') {
      return `Provider identifier cannot be blank for model pool entry "${entry.model}"`;
    }
  }
  const baseError = await validateAgentModelPool(pool);
  if (baseError) return baseError;
  for (const entry of pool) {
    const error = await validateAgentModel(entry.model, entry.provider);
    if (error) return error;
  }
  return null;
}

function createValidateKey(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const error = validateTemplateKey(ctx.params.key);
  if (error) return { ...ctx, error };
  return ctx;
}

function createValidateHandle(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const error = validateTemplateHandle(ctx.params.handle);
  if (error) return { ...ctx, error };
  return ctx;
}

function createValidateDisplayName(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const error = validateDisplayName(ctx.params.displayName);
  if (error) return { ...ctx, error };
  return ctx;
}

function createValidateAutonomy(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const error = validateAutonomyLevel(ctx.params.suggestedAutonomyLevel);
  if (error) return { ...ctx, error };
  return ctx;
}

function createValidateTools(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const error = validateToolsChoice(ctx.params.tools);
  if (error) return { ...ctx, error };
  return ctx;
}

async function createValidateModel(ctx: CreateTemplateCtx): Promise<CreateTemplateCtx> {
  const error = await validateModelChoice(ctx.params.model, ctx.params.provider);
  if (error) return { ...ctx, error };
  return ctx;
}

async function createValidateModelPool(ctx: CreateTemplateCtx): Promise<CreateTemplateCtx> {
  const error = await validateTemplateModelPool(ctx.params.modelPool);
  if (error) return { ...ctx, error };
  return ctx;
}

function createCheckKeyAvailable(ctx: CreateTemplateCtx): CreateTemplateCtx {
  if (ctx.repo.getByKey(ctx.params.key)) {
    return { ...ctx, error: `Template key already exists: ${ctx.params.key}` };
  }
  return ctx;
}

function createPersist(ctx: CreateTemplateCtx): CreateTemplateCtx {
  try {
    return { ...ctx, template: ctx.repo.create(ctx.params) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ...ctx, error: `Failed to create template: ${detail}` };
  }
}

function updateLoadExisting(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const existing = ctx.repo.getByKeyWithVersion(ctx.key);
  if (!existing) return { ...ctx, error: `Template not found: ${ctx.key}` };
  return { ...ctx, existing, version: existing.version };
}

function updateValidateHandle(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  if (ctx.params.handle === undefined) return ctx;
  const error = validateTemplateHandle(ctx.params.handle);
  if (error) return { ...ctx, error };
  return ctx;
}

function updateValidateDisplayName(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const error = validateDisplayName(ctx.params.displayName);
  if (error) return { ...ctx, error };
  return ctx;
}

function updateValidateAutonomy(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const error = validateAutonomyLevel(ctx.params.suggestedAutonomyLevel);
  if (error) return { ...ctx, error };
  return ctx;
}

function updateValidateTools(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const error = validateToolsChoice(ctx.params.tools);
  if (error) return { ...ctx, error };
  return ctx;
}

async function updateValidateModel(ctx: UpdateTemplateCtx): Promise<UpdateTemplateCtx> {
  if (ctx.existing === undefined) return ctx;
  if (ctx.params.model === undefined && ctx.params.provider === undefined) return ctx;
  const nextModel = ctx.params.model !== undefined ? ctx.params.model : ctx.existing.model;
  const nextProvider =
    ctx.params.provider !== undefined ? ctx.params.provider : ctx.existing.provider;
  const error = await validateModelChoice(nextModel, nextProvider);
  if (error) return { ...ctx, error };
  return ctx;
}

async function updateValidateModelPool(ctx: UpdateTemplateCtx): Promise<UpdateTemplateCtx> {
  const error = await validateTemplateModelPool(ctx.params.modelPool);
  if (error) return { ...ctx, error };
  return ctx;
}

function updatePersist(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  if (ctx.version === undefined) return { ...ctx, error: `Template version missing: ${ctx.key}` };
  const template = ctx.repo.casUpdate(ctx.key, ctx.params, ctx.version);
  if (!template) {
    return { ...ctx, template: null };
  }
  return { ...ctx, template };
}

function deleteLoadExisting(ctx: DeleteTemplateCtx): DeleteTemplateCtx {
  const existing = ctx.repo.getByKey(ctx.key);
  if (!existing) return { ...ctx, error: `Template not found: ${ctx.key}` };
  return { ...ctx, existing };
}

function deletePersist(ctx: DeleteTemplateCtx): DeleteTemplateCtx {
  const deleted = ctx.repo.delete(ctx.key);
  if (!deleted) return { ...ctx, error: `Template not found after delete: ${ctx.key}` };
  return { ...ctx, deleted: true };
}

const templatePipeline = superpipe({
  hasError: (ctx: { error?: string }) => ctx.error !== undefined,
});

export const runCreateTemplate = (templatePipeline('create-space-agent-template') as PipelineAPI)
  .input(['ctx'])
  .pipe(createValidateKey, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateHandle, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateDisplayName, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateAutonomy, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateTools, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateModel, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createValidateModelPool, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createCheckKeyAvailable, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(createPersist, 'ctx', 'ctx')
  .endAsync('ctx') as (input: CreateTemplateCtx) => Promise<CreateTemplateCtx>;

export const runUpdateTemplate = (templatePipeline('update-space-agent-template') as PipelineAPI)
  .input(['ctx'])
  .pipe(updateLoadExisting, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateHandle, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateDisplayName, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateAutonomy, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateTools, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateModel, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updateValidateModelPool, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(updatePersist, 'ctx', 'ctx')
  .endAsync('ctx') as (input: UpdateTemplateCtx) => Promise<UpdateTemplateCtx>;

export const runDeleteTemplate = (templatePipeline('delete-space-agent-template') as PipelineAPI)
  .input(['ctx'])
  .pipe(deleteLoadExisting, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(deletePersist, 'ctx', 'ctx')
  .end('ctx') as (input: DeleteTemplateCtx) => DeleteTemplateCtx;

export class SpaceAgentTemplateManager {
  constructor(
    private repo: SpaceAgentTemplateRepository,
    private builtIns: BuiltInTemplateSource = getBuiltInSpaceAgentTemplates
  ) {}

  async create(
    params: CreateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate>> {
    const ctx = await runCreateTemplate({ repo: this.repo, params });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: ctx.template! };
  }

  async update(
    key: string,
    params: UpdateSpaceAgentTemplateParams
  ): Promise<SpaceAgentResult<SpaceAgentTemplate | null>> {
    const ctx = await runUpdateTemplate({ repo: this.repo, key, params });
    if (ctx.error) return { ok: false, error: ctx.error };
    if (ctx.template === null) return { ok: true, value: null };
    return { ok: true, value: ctx.template! };
  }

  delete(key: string): SpaceAgentResult<void> {
    const ctx = runDeleteTemplate({ repo: this.repo, key });
    if (ctx.error) return { ok: false, error: ctx.error };
    return { ok: true, value: undefined };
  }

  list(): SpaceAgentTemplate[] {
    const byKey = new Map<string, SpaceAgentTemplate>();
    for (const template of this.builtIns()) byKey.set(template.key, template);
    for (const template of this.repo.list()) {
      if (!byKey.has(template.key)) byKey.set(template.key, template);
    }
    return [...byKey.values()].sort(compareByCreatedAtAndKey);
  }

  getByKey(key: string): SpaceAgentTemplate | null {
    return (
      this.builtIns().find((template) => template.key === key) ?? this.repo.getByKey(key) ?? null
    );
  }
}

function compareByCreatedAtAndKey(a: SpaceAgentTemplate, b: SpaceAgentTemplate): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.key.localeCompare(b.key);
}
