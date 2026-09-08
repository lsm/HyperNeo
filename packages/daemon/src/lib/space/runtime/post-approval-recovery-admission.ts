import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type PostApprovalRecoveryAdmissionOutcome =
  | { value: { action: 'redispatch'; task: SpaceTask } }
  | {
      reason:
        | 'task-not-eligible'
        | 'retry-cadence-pending'
        | 'recovery-in-flight'
        | 'dispatch-claim-leased'
        | 'worker-revived'
        | 'orphan-adopted'
        | 'recovery-await-timeout';
    };

export interface PostApprovalRecoveryAdmissionDeps {
  isDispatchDead(task: SpaceTask): boolean;
  isUnrecordedStale(task: SpaceTask): boolean;
  cadencePending(taskId: string, now: number): boolean;
  markCadence(taskId: string, now: number): void;
  recoveryInFlight(taskId: string, generation: number): boolean;
  hasLeasedClaim(task: SpaceTask): boolean;
  isReviveBypassed(task: SpaceTask, generation: number): boolean;
  adoptBypassed(task: SpaceTask, generation: number): boolean;
  revive(task: SpaceTask, generation: number): Promise<'revived' | 'skip' | 'replace' | 'timeout'>;
  adopt(task: SpaceTask, generation: number): Promise<boolean | 'timeout'>;
  clearBypass(taskId: string): void;
}

export interface PostApprovalRecoveryAdmissionCtx extends PostApprovalRecoveryAdmissionDeps {
  task: SpaceTask;
  generation: number;
  now: number;
  dispatchDead: boolean;
  unrecordedStale: boolean;
  reviveBypassed: boolean;
  halt: string | null;
}

function halted(
  ctx: PostApprovalRecoveryAdmissionCtx,
  reason: string
): PostApprovalRecoveryAdmissionCtx {
  return { ...ctx, halt: reason };
}

export function loadAdmissionFacts(
  ctx: PostApprovalRecoveryAdmissionCtx
): PostApprovalRecoveryAdmissionCtx {
  return {
    ...ctx,
    dispatchDead: ctx.isDispatchDead(ctx.task),
    unrecordedStale: ctx.isUnrecordedStale(ctx.task),
    reviveBypassed: ctx.isReviveBypassed(ctx.task, ctx.generation),
  };
}

export function gateTaskEligibility(
  ctx: PostApprovalRecoveryAdmissionCtx
): PostApprovalRecoveryAdmissionCtx {
  const task = ctx.task;
  if (!ctx.dispatchDead && !task.postApprovalBlockedReason && !ctx.unrecordedStale) {
    return halted(ctx, 'task-not-eligible');
  }
  if (ctx.cadencePending(task.id, ctx.now)) {
    return halted(ctx, 'retry-cadence-pending');
  }
  ctx.markCadence(task.id, ctx.now);
  if (ctx.recoveryInFlight(task.id, ctx.generation)) {
    return halted(ctx, 'recovery-in-flight');
  }
  if (ctx.hasLeasedClaim(task)) {
    return halted(ctx, 'dispatch-claim-leased');
  }
  return ctx;
}

export async function attemptWorkerRevival(
  ctx: PostApprovalRecoveryAdmissionCtx
): Promise<PostApprovalRecoveryAdmissionCtx> {
  if (!ctx.dispatchDead || ctx.reviveBypassed) return ctx;
  const outcome = await ctx.revive(ctx.task, ctx.generation);
  if (outcome === 'timeout') return halted(ctx, 'recovery-await-timeout');
  if (outcome !== 'replace') return halted(ctx, 'worker-revived');
  return ctx;
}

export async function attemptOrphanAdoption(
  ctx: PostApprovalRecoveryAdmissionCtx
): Promise<PostApprovalRecoveryAdmissionCtx> {
  if (ctx.task.postApprovalSessionId) return ctx;
  if (ctx.adoptBypassed(ctx.task, ctx.generation)) return ctx;
  const outcome = await ctx.adopt(ctx.task, ctx.generation);
  if (outcome === 'timeout') return halted(ctx, 'recovery-await-timeout');
  if (outcome === true) return halted(ctx, 'orphan-adopted');
  return ctx;
}

export function finalizeRedispatch(
  ctx: PostApprovalRecoveryAdmissionCtx
): PostApprovalRecoveryAdmissionOutcome {
  if (ctx.halt !== null) {
    return {
      reason: ctx.halt as PostApprovalRecoveryAdmissionOutcome extends { reason: infer R }
        ? R
        : never,
    };
  }
  ctx.clearBypass(ctx.task.id);
  return { value: { action: 'redispatch', task: ctx.task } };
}

const recoveryAdmissionRun = (
  superpipe<{ halted: (ctx: PostApprovalRecoveryAdmissionCtx) => boolean }>({
    halted: (ctx: PostApprovalRecoveryAdmissionCtx): boolean => ctx.halt !== null,
  })('post-approval-recovery-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadAdmissionFacts, 'ctx', 'ctx')
  .pipe(gateTaskEligibility, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(attemptWorkerRevival, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(attemptOrphanAdoption, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .endAsync('ctx');

export async function runPostApprovalRecoveryAdmission(
  input: PostApprovalRecoveryAdmissionDeps & {
    task: SpaceTask;
    generation: number;
    now: number;
  }
): Promise<PostApprovalRecoveryAdmissionOutcome> {
  const ctx = (await recoveryAdmissionRun({
    ...input,
    dispatchDead: false,
    unrecordedStale: false,
    reviveBypassed: false,
    halt: null,
  })) as PostApprovalRecoveryAdmissionCtx;
  return finalizeRedispatch(ctx);
}
