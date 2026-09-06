import {
  type CreateSpaceParams,
  MAX_SPACE_CONCURRENT_TASKS,
  MIN_SPACE_CONCURRENT_TASKS,
  type Space,
  type SpaceAutonomyLevel,
  type SpaceCreateResult,
} from '@hyperneo/shared';
import superpipe, { type PipelineAPI, type Result } from 'superpipe';
import type { CreateSessionParams } from '../session/session-lifecycle.ts';

const VALID_AUTONOMY_LEVELS: SpaceAutonomyLevel[] = [1, 2, 3, 4, 5];

export interface CreateSpaceDeps {
  createSpaceRecord(params: CreateSpaceParams): Promise<Space>;
  ensureCoordinator(spaceId: string): unknown;
  seedWorkflows(spaceId: string): { errors: ReadonlyArray<{ name: string; error: string }> };
  chat?: {
    createSession(params: CreateSessionParams): Promise<string>;
    addSession(spaceId: string, sessionId: string): Promise<Space>;
    provisionRuntime?(space: Space): Promise<void>;
  };
  dispatchSpaceCreated(space: Space): Promise<void>;
  warn(message: string, error?: unknown): void;
}

export interface CreateSpaceCtx {
  params: CreateSpaceParams;
  deps: CreateSpaceDeps;
  warnings: string[];
  space?: Space;
  result?: SpaceCreateResult;
}

type ValidateParamsResult = Result<CreateSpaceCtx, Error>;

function invalidConcurrentLimit(limit: unknown): Error | undefined {
  const valid =
    typeof limit === 'number' &&
    Number.isInteger(limit) &&
    limit >= MIN_SPACE_CONCURRENT_TASKS &&
    limit <= MAX_SPACE_CONCURRENT_TASKS;
  return valid
    ? undefined
    : new Error(
        `Invalid concurrent task limit: ${String(limit)}. Must be an integer between ${MIN_SPACE_CONCURRENT_TASKS} and ${MAX_SPACE_CONCURRENT_TASKS}`
      );
}

function withWarning(ctx: CreateSpaceCtx, warning: string): CreateSpaceCtx {
  return { ...ctx, warnings: [...ctx.warnings, warning] };
}

function requireSpace(ctx: CreateSpaceCtx): Space {
  if (!ctx.space) throw new Error('createSpace pipeline requires a space');
  return ctx.space;
}

export function validateParams(ctx: CreateSpaceCtx): ValidateParamsResult {
  const { params } = ctx;
  let reason: Error | undefined;
  if (!params.workspacePath) {
    reason = new Error('workspacePath is required');
  } else if (!params.name || params.name.trim() === '') {
    reason = new Error('name is required');
  } else if (
    params.autonomyLevel !== undefined &&
    !VALID_AUTONOMY_LEVELS.includes(params.autonomyLevel)
  ) {
    reason = new Error(
      `Invalid autonomyLevel: ${params.autonomyLevel}. Must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')}`
    );
  } else if (params.maxConcurrentTasks !== undefined) {
    reason = invalidConcurrentLimit(params.maxConcurrentTasks);
  }
  if (!reason && params.config?.maxConcurrentTasks !== undefined) {
    reason = invalidConcurrentLimit(params.config.maxConcurrentTasks);
  }
  if (!reason && params.additionalWorkspaces) {
    const index = params.additionalWorkspaces.findIndex(
      (workspace) => typeof workspace?.path !== 'string' || workspace.path.trim() === ''
    );
    if (index >= 0) reason = new Error(`additionalWorkspaces[${index}].path is required`);
  }
  return reason ? { reason } : { value: ctx };
}

export async function createSpaceRecord(ctx: CreateSpaceCtx): Promise<CreateSpaceCtx> {
  return { ...ctx, space: await ctx.deps.createSpaceRecord(ctx.params) };
}

export function ensureCoordinator(ctx: CreateSpaceCtx): CreateSpaceCtx {
  ctx.deps.ensureCoordinator(requireSpace(ctx).id);
  return ctx;
}

export function seedWorkflows(ctx: CreateSpaceCtx): CreateSpaceCtx {
  const space = requireSpace(ctx);
  try {
    const { errors } = ctx.deps.seedWorkflows(space.id);
    if (errors.length === 0) return ctx;
    const failedNames = errors.map((error) => error.name).join(', ');
    ctx.deps.warn(`Partial workflow seed failure for space ${space.id}: ${failedNames}`, errors);
    return withWarning(ctx, `Failed to seed workflows: ${failedNames}`);
  } catch (error) {
    ctx.deps.warn(`Failed to seed built-in workflows for space ${space.id}`, error);
    return withWarning(ctx, 'Failed to seed built-in workflows');
  }
}

export async function provisionChatSession(ctx: CreateSpaceCtx): Promise<CreateSpaceCtx> {
  const space = requireSpace(ctx);
  if (!ctx.deps.chat) return ctx;
  const sessionId = `space:chat:${space.id}`;
  try {
    await ctx.deps.chat.createSession({
      sessionId,
      title: space.name,
      workspacePath: space.workspacePath,
      config: { model: space.defaultModel },
      sessionType: 'space_chat',
      spaceId: space.id,
    });
    await ctx.deps.chat.addSession(space.id, sessionId);
  } catch (error) {
    ctx.deps.warn(`Failed to create space chat session for space ${space.id}`, error);
    return ctx;
  }
  try {
    await ctx.deps.chat.provisionRuntime?.(space);
  } catch (error) {
    ctx.deps.warn(`Failed to provision space chat session for space ${space.id}`, error);
  }
  return ctx;
}

export function publishSpaceCreated(ctx: CreateSpaceCtx): CreateSpaceCtx {
  ctx.deps.dispatchSpaceCreated(requireSpace(ctx)).catch((error) => {
    ctx.deps.warn('Failed to emit space.created', error);
  });
  return ctx;
}

export function assembleResult(ctx: CreateSpaceCtx): CreateSpaceCtx {
  const space = requireSpace(ctx);
  const result = ctx.warnings.length === 0 ? space : { ...space, seedWarnings: [...ctx.warnings] };
  return { ...ctx, result };
}

const runCreateSpace = (superpipe()('createSpace') as PipelineAPI)
  .input(['ctx'])
  .pipe(validateParams, 'ctx', 'result:ctx')
  .pipe(createSpaceRecord, 'ctx', 'ctx')
  .pipe(ensureCoordinator, 'ctx', 'ctx')
  .pipe(seedWorkflows, 'ctx', 'ctx')
  .pipe(provisionChatSession, 'ctx', 'ctx')
  .pipe(publishSpaceCreated, 'ctx', 'ctx')
  .pipe(assembleResult, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: CreateSpaceCtx) => Promise<CreateSpaceCtx | Error>;

export async function createSpace(
  deps: CreateSpaceDeps,
  params: CreateSpaceParams
): Promise<SpaceCreateResult> {
  const outcome = await runCreateSpace({ deps, params, warnings: [] });
  if (outcome instanceof Error) throw outcome;
  if (!outcome.result) throw new Error('createSpace pipeline completed without a result');
  return outcome.result;
}
