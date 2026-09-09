import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type DurableKickoffReuseResult =
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
  result: DurableKickoffReuseResult | null;
}

function settled(
  ctx: DurableKickoffReuseCtx,
  result: DurableKickoffReuseResult
): DurableKickoffReuseCtx {
  return { ...ctx, result };
}

export function loadKickoffFacts(ctx: DurableKickoffReuseCtx): DurableKickoffReuseCtx {
  return { ...ctx, alreadyDelivered: ctx.hasDurableKickoff(ctx.task, ctx.sessionId) };
}

export function gateFreshInjection(ctx: DurableKickoffReuseCtx): DurableKickoffReuseCtx {
  if (ctx.alreadyDelivered) return ctx;
  return settled(ctx, { value: { action: 'inject' } });
}

export async function resumeDeliveredWorker(
  ctx: DurableKickoffReuseCtx
): Promise<DurableKickoffReuseCtx> {
  if (ctx.isQueryActive(ctx.sessionId)) {
    return settled(ctx, { reason: 'already-running' });
  }
  try {
    await ctx.admitResume(ctx.task);
  } catch {
    return settled(ctx, {
      value: {
        action: 'refuse',
        reason: `reused session ${ctx.sessionId} already holds this approval generation's kickoff but its query could not be admitted`,
      },
    });
  }
  await ctx.startQuery(ctx.sessionId);
  if (!ctx.isQueryActive(ctx.sessionId)) {
    return settled(ctx, {
      value: {
        action: 'refuse',
        reason: `reused session ${ctx.sessionId} already holds this approval generation's kickoff but its query could not be started`,
      },
    });
  }
  return settled(ctx, { reason: 'resumed' });
}

const kickoffReuseRun = (
  superpipe<{ admitted: (ctx: DurableKickoffReuseCtx) => boolean }>({
    admitted: (ctx: DurableKickoffReuseCtx): boolean => ctx.result !== null,
  })('durable-kickoff-reuse-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadKickoffFacts, 'ctx', 'ctx')
  .pipe(gateFreshInjection, 'ctx', 'ctx')
  .pipe('!admitted', 'ctx')
  .pipe(resumeDeliveredWorker, 'ctx', 'ctx')
  .endAsync('ctx');

export async function runDurableKickoffReuseAdmission(
  input: DurableKickoffReuseDeps & { task: SpaceTask; sessionId: string }
): Promise<DurableKickoffReuseResult> {
  const ctx = (await kickoffReuseRun({
    ...input,
    alreadyDelivered: false,
    result: null,
  })) as DurableKickoffReuseCtx;
  if (ctx.result !== null) return ctx.result;
  return { reason: 'resumed' };
}
