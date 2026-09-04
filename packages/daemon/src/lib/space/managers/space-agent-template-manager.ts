import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  UpdateSpaceAgentTemplateParams,
  WorkerAgentModelPoolEntry,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpaceAgentTemplateRepository } from '../../../storage/repositories/space-agent-template-repository.ts';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../agents/worker-long-horizon-mapper.ts';
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

interface CreateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  params: CreateSpaceAgentTemplateParams;
  error?: string;
  template?: SpaceAgentTemplate;
}

interface UpdateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  key: string;
  params: UpdateSpaceAgentTemplateParams;
  existing?: SpaceAgentTemplate;
  error?: string;
  template?: SpaceAgentTemplate;
}

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

function validateTemplateKey(key: string): string | null {
  if (!key || key.trim() !== key) {
    return 'Template key cannot be empty or have leading/trailing whitespace';
  }
  if (key === MIGRATED_WORKER_TEMPLATE_KEY) {
    return `Template key "${key}" is reserved`;
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
  if (model === undefined || model === null || model === '') return null;
  return validateAgentModel(model, provider);
}

async function validateModelPoolChoice(
  pool: WorkerAgentModelPoolEntry[] | null | undefined
): Promise<string | null> {
  if (pool === undefined || pool === null || pool.length === 0) return null;
  return validateAgentModelPool(pool);
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
  const error = await validateModelPoolChoice(ctx.params.modelPool);
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
  return { ...ctx, template: ctx.repo.create(ctx.params) };
}

function updateLoadExisting(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const existing = ctx.repo.getByKey(ctx.key);
  if (!existing) return { ...ctx, error: `Template not found: ${ctx.key}` };
  return { ...ctx, existing };
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
  const error = await validateModelPoolChoice(ctx.params.modelPool);
  if (error) return { ...ctx, error };
  return ctx;
}

function updatePersist(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const template = ctx.repo.update(ctx.key, ctx.params);
  if (!template) return { ...ctx, error: `Template not found after update: ${ctx.key}` };
  return { ...ctx, template };
}

const templatePipeline = superpipe({
  hasError: (ctx: { error?: string }) => ctx.error !== undefined,
});

const runCreateTemplate = (templatePipeline('create-space-agent-template') as PipelineAPI)
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

const runUpdateTemplate = (templatePipeline('update-space-agent-template') as PipelineAPI)
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
    return { ok: true, value: ctx.template! };
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

function compareByCreatedAtAndKey(a: SpaceAgentTemplate, b: SpaceAgentTemplate): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.key.localeCompare(b.key);
}
