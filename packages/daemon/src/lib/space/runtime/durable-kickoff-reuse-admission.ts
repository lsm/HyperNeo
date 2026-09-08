import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type DurableKickoffReuseOutcome =
  | { value: { action: 'inject' } }
  | { value: { action: 'refuse'; reason: string } }
  | { reason: 'already-running' | 'resumed' };

export interface DurableKickoffReuseDeps {
  hasDurableKickoff(task: SpaceTask, sessionId: string): boolean;
  isQueryActive(sessionId: string): boolean;
  admitResume(task: SpaceTask): Promise<void>;
  startQuery(sessionId: string): Promise<void>;
}

export interface DurableKickoffReuseCtx extends DurableKickoffReuseDeps {
  task: SpaceTask;
  sessionId: string;
  alreadyDelivered: boolean;
  halt: string | null;
}

function halted(ctx: DurableKickoffReuseCtx, reason: string): DurableKickoffReuseCtx {
  return { ...ctx, halt: reason };
}

export function loadKickoffFacts(ctx: DurableKickoffReuseCtx): DurableKickoffReuseCtx {
  return { ...ctx, alreadyDelivered: ctx.hasDurableKickoff(ctx.task, ctx.sessionId) };
}

export function gateFreshInjection(ctx: DurableKickoffReuseCtx): DurableKickoffReuseCtx {
  if (ctx.alreadyDelivered) return ctx;
  return halted(ctx, 'fresh-kickoff');
}

export async function resumeDeliveredWorker(
  ctx: DurableKickoffReuseCtx
): Promise<DurableKickoffReuseCtx> {
  if (ctx.isQueryActive(ctx.sessionId)) {
    return halted(ctx, 'already-running');
  }
  try {
    await ctx.admitResume(ctx.task);
  } catch {
    return halted(ctx, 'resume-refused');
  }
  await ctx.startQuery(ctx.sessionId);
  if (!ctx.isQueryActive(ctx.sessionId)) {
    return halted(ctx, 'resume-refused');
  }
  return halted(ctx, 'resumed');
}

export function finalizeKickoffReuse(ctx: DurableKickoffReuseCtx): DurableKickoffReuseOutcome {
  if (ctx.halt === 'fresh-kickoff') {
    return { value: { action: 'inject' } };
  }
  if (ctx.halt === 'already-running' || ctx.halt === 'resumed') {
    return { reason: ctx.halt };
  }
  return {
    value: {
      action: 'refuse',
      reason: `reused session ${ctx.sessionId} already holds this approval generation's kickoff but its query could not be admitted; refusing to record an idle post-approval worker`,
    },
  };
}

const kickoffReuseRun = (
  superpipe<{ halted: (ctx: DurableKickoffReuseCtx) => boolean }>({
    halted: (ctx: DurableKickoffReuseCtx): boolean => ctx.halt !== null,
  })('durable-kickoff-reuse-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadKickoffFacts, 'ctx', 'ctx')
  .pipe(gateFreshInjection, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(resumeDeliveredWorker, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runDurableKickoffReuseAdmission(
  input: DurableKickoffReuseDeps & { task: SpaceTask; sessionId: string }
): Promise<DurableKickoffReuseOutcome> {
  const ctx = (await kickoffReuseRun({
    ...input,
    alreadyDelivered: false,
    halt: null,
  })) as DurableKickoffReuseCtx;
  return finalizeKickoffReuse(ctx);
}
