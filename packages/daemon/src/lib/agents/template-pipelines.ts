import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentTemplate,
  UpdateSpaceAgentTemplateParams,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type {
  SpaceAgentTemplateRecord,
  SpaceAgentTemplateRepository,
} from '../../storage/repositories/space-agent-template-repository.ts';
import { isRelocationMarkerLabel } from './long-horizon-templates.ts';
import {
  normalizeTemplateLabels,
  stripRelocationMarkerLabels,
  validateAutonomyLevel,
  validateDisplayName,
  validateModelChoice,
  validateTemplateHandle,
  validateTemplateKey,
  validateTemplateModelPool,
  validateToolsChoice,
} from './template-field-validation.ts';

export interface CreateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  spaceId: string;
  params: CreateSpaceAgentTemplateParams;
  error?: string;
  template?: SpaceAgentTemplate;
}

export interface UpdateTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  spaceId: string;
  key: string;
  params: UpdateSpaceAgentTemplateParams;
  expectedVersion?: number;
  existing?: SpaceAgentTemplateRecord;
  version?: number;
  error?: string;
  template?: SpaceAgentTemplate | null;
}

export interface TemplateInstanceScan {
  clearArchivedInstances?(key: string, spaceId: string): void;
}

export interface DeleteTemplateCtx {
  repo: SpaceAgentTemplateRepository;
  spaceId: string;
  key: string;
  expectedVersion?: number;
  instanceScan?: TemplateInstanceScan;
  existing?: SpaceAgentTemplate;
  version?: number;
  error?: string;
  deleted?: boolean;
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

function createValidateLabels(ctx: CreateTemplateCtx): CreateTemplateCtx {
  const { labels, error } = normalizeTemplateLabels(stripRelocationMarkerLabels(ctx.params.labels));
  if (error) return { ...ctx, error };
  return { ...ctx, params: { ...ctx.params, labels } };
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
  if (ctx.repo.getOwned(ctx.spaceId, ctx.params.key)) {
    return { ...ctx, error: `Template key already exists: ${ctx.params.key}` };
  }
  return ctx;
}

function createPersist(ctx: CreateTemplateCtx): CreateTemplateCtx {
  try {
    return {
      ...ctx,
      template: ctx.repo.createOwned(ctx.spaceId, ctx.params),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ...ctx, error: `Failed to create template: ${detail}` };
  }
}

function updateLoadExisting(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  const existing = ctx.repo.getOwnedWithVersion(ctx.spaceId, ctx.key);
  if (!existing) return { ...ctx, error: `Template not found: ${ctx.key}` };
  return { ...ctx, existing, version: ctx.expectedVersion ?? existing.version };
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

function updateValidateLabels(ctx: UpdateTemplateCtx): UpdateTemplateCtx {
  if (ctx.params.labels === undefined) return ctx;
  const { labels, error } = normalizeTemplateLabels(stripRelocationMarkerLabels(ctx.params.labels));
  if (error) return { ...ctx, error };
  const sticky = (ctx.existing?.labels ?? []).filter((label) => isRelocationMarkerLabel(label));
  const merged = [...labels];
  for (const label of sticky) {
    if (!merged.includes(label)) merged.push(label);
  }
  return { ...ctx, params: { ...ctx.params, labels: merged } };
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
  const template = ctx.repo.casUpdateOwned(
    ctx.spaceId,
    ctx.key,
    ctx.params,
    ctx.expectedVersion ?? ctx.version
  );
  if (!template) {
    return { ...ctx, template: null };
  }
  return { ...ctx, template };
}

function deleteLoadExisting(ctx: DeleteTemplateCtx): DeleteTemplateCtx {
  const existing = ctx.repo.getOwnedWithVersion(ctx.spaceId, ctx.key);
  if (!existing) return { ...ctx, error: `Template not found: ${ctx.key}` };
  return { ...ctx, existing, version: existing.version };
}

function deleteCheckVersion(ctx: DeleteTemplateCtx): DeleteTemplateCtx {
  if (ctx.expectedVersion === undefined || ctx.version === undefined) return ctx;
  if (ctx.expectedVersion === ctx.version) return ctx;
  return {
    ...ctx,
    error:
      `Template "${ctx.key}" was modified concurrently: expected version ${ctx.expectedVersion}, ` +
      `current version ${ctx.version}. Re-read the template and retry with the current version.`,
  };
}

function deletePersist(ctx: DeleteTemplateCtx): DeleteTemplateCtx {
  const deleted = ctx.repo.deleteOwned(ctx.spaceId, ctx.key, ctx.expectedVersion);
  if (deleted) {
    ctx.instanceScan?.clearArchivedInstances?.(ctx.key, ctx.spaceId);
    return { ...ctx, deleted: true };
  }
  if (ctx.expectedVersion !== undefined && ctx.repo.getOwned(ctx.spaceId, ctx.key)) {
    return { ...ctx, error: `Template "${ctx.key}" was modified concurrently; delete aborted.` };
  }
  return { ...ctx, error: `Template not found after delete: ${ctx.key}` };
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
  .pipe(createValidateLabels, 'ctx', 'ctx')
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
  .pipe(updateValidateLabels, 'ctx', 'ctx')
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
  .pipe(deleteCheckVersion, 'ctx', 'ctx')
  .pipe('!hasError', 'ctx')
  .pipe(deletePersist, 'ctx', 'ctx')
  .end('ctx') as (input: DeleteTemplateCtx) => DeleteTemplateCtx;
