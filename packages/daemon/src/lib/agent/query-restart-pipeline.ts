import type { PipelineAPI } from 'superpipe';
import superpipe from 'superpipe';
import type { IdleOwnerScope } from './processing-state-manager.ts';

export interface QueryRestartHost {
  isIdleOwnerCurrent(): boolean;
  resetTurnGuards(): void;
  publishErrorClear(): Promise<void>;
  stopQuery(): Promise<void>;
  settleSuppressedIdle(idleOwner?: IdleOwnerScope): Promise<void>;
  repairSessionFile(): Promise<void>;
  clearModelsCacheState(): Promise<void>;
  startStreaming(): Promise<void>;
}

export interface QueryRestartPipelineCtx {
  host: QueryRestartHost;
  idleOwner?: IdleOwnerScope;
  superseded: boolean;
  reachedSuppressedIdle: boolean;
}

function resetTurnGuardsStage(ctx: QueryRestartPipelineCtx): QueryRestartPipelineCtx {
  ctx.host.resetTurnGuards();
  return ctx;
}

async function publishErrorClearStage(
  ctx: QueryRestartPipelineCtx
): Promise<QueryRestartPipelineCtx> {
  await ctx.host.publishErrorClear();
  return ctx;
}

function recheckOwnershipStage(ctx: QueryRestartPipelineCtx): QueryRestartPipelineCtx {
  if (!ctx.host.isIdleOwnerCurrent()) {
    ctx.superseded = true;
  }
  return ctx;
}

async function stopQueryStage(ctx: QueryRestartPipelineCtx): Promise<QueryRestartPipelineCtx> {
  await ctx.host.stopQuery();
  return ctx;
}

async function settleSuppressedIdleStage(
  ctx: QueryRestartPipelineCtx
): Promise<QueryRestartPipelineCtx> {
  await ctx.host.settleSuppressedIdle(ctx.idleOwner);
  ctx.reachedSuppressedIdle = true;
  return ctx;
}

async function repairSessionFileStage(
  ctx: QueryRestartPipelineCtx
): Promise<QueryRestartPipelineCtx> {
  await ctx.host.repairSessionFile();
  return ctx;
}

async function clearModelsCacheStage(
  ctx: QueryRestartPipelineCtx
): Promise<QueryRestartPipelineCtx> {
  await ctx.host.clearModelsCacheState();
  return ctx;
}

async function startStreamingStage(ctx: QueryRestartPipelineCtx): Promise<QueryRestartPipelineCtx> {
  await ctx.host.startStreaming();
  return ctx;
}

function haltIfSuperseded(ctx: QueryRestartPipelineCtx): boolean {
  return ctx.superseded;
}

const stages: ReadonlyArray<{
  step: (
    ctx: QueryRestartPipelineCtx
  ) => Promise<QueryRestartPipelineCtx> | QueryRestartPipelineCtx;
  ownershipGateBefore?: boolean;
  ownershipGateAfter?: boolean;
}> = [
  { step: resetTurnGuardsStage, ownershipGateBefore: true },
  { step: publishErrorClearStage, ownershipGateAfter: true },
  { step: stopQueryStage, ownershipGateAfter: true },
  { step: settleSuppressedIdleStage, ownershipGateAfter: true },
  { step: repairSessionFileStage },
  { step: clearModelsCacheStage, ownershipGateAfter: true },
  { step: startStreamingStage },
];

let api = (
  superpipe<{ haltIfSuperseded: (ctx: QueryRestartPipelineCtx) => boolean }>({
    haltIfSuperseded,
  })('query-restart') as PipelineAPI
).input(['ctx']);
for (const stage of stages) {
  if (stage.ownershipGateBefore) {
    api = api.pipe(recheckOwnershipStage, 'ctx', 'ctx').pipe('!haltIfSuperseded', 'ctx');
  }
  api = api.pipe(stage.step, 'ctx', 'ctx');
  if (stage.ownershipGateAfter) {
    api = api.pipe(recheckOwnershipStage, 'ctx', 'ctx').pipe('!haltIfSuperseded', 'ctx');
  }
}
const runQueryRestart = api.endAsync('ctx') as (
  ctx: QueryRestartPipelineCtx
) => Promise<QueryRestartPipelineCtx>;

export function createQueryRestartCtx(
  host: QueryRestartHost,
  idleOwner?: IdleOwnerScope
): QueryRestartPipelineCtx {
  return {
    host,
    idleOwner,
    superseded: false,
    reachedSuppressedIdle: false,
  };
}

export async function runQueryRestartPipeline(ctx: QueryRestartPipelineCtx): Promise<void> {
  await runQueryRestart(ctx);
}
