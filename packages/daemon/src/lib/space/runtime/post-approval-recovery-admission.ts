import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type PostApprovalRecoveryAdmissionReason =
  | 'task-not-eligible'
  | 'retry-cadence-pending'
  | 'recovery-in-flight'
  | 'dispatch-claim-leased'
  | 'worker-revived'
  | 'orphan-adopted'
  | 'recovery-await-timeout';

export type PostApprovalRecoveryAdmissionResult =
  | { value: { action: 'redispatch'; task: SpaceTask } }
  | { reason: PostApprovalRecoveryAdmissionReason };

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
  result: PostApprovalRecoveryAdmissionResult | null;
}

function settled(
  ctx: PostApprovalRecoveryAdmissionCtx,
  reason: PostApprovalRecoveryAdmissionReason
): PostApprovalRecoveryAdmissionCtx {
  return { ...ctx, result: { reason } };
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
    return settled(ctx, 'task-not-eligible');
  }
  if (ctx.cadencePending(task.id, ctx.now)) {
    return settled(ctx, 'retry-cadence-pending');
  }
  ctx.markCadence(task.id, ctx.now);
  if (ctx.recoveryInFlight(task.id, ctx.generation)) {
    return settled(ctx, 'recovery-in-flight');
  }
  if (ctx.hasLeasedClaim(task)) {
    return settled(ctx, 'dispatch-claim-leased');
  }
  return ctx;
}

export async function attemptWorkerRevival(
  ctx: PostApprovalRecoveryAdmissionCtx
): Promise<PostApprovalRecoveryAdmissionCtx> {
  if (!ctx.dispatchDead || ctx.reviveBypassed) return ctx;
  const outcome = await ctx.revive(ctx.task, ctx.generation);
  if (outcome === 'timeout') return settled(ctx, 'recovery-await-timeout');
  if (outcome !== 'replace') return settled(ctx, 'worker-revived');
  return ctx;
}

export async function attemptOrphanAdoption(
  ctx: PostApprovalRecoveryAdmissionCtx
): Promise<PostApprovalRecoveryAdmissionCtx> {
  if (ctx.task.postApprovalSessionId) return ctx;
  if (ctx.adoptBypassed(ctx.task, ctx.generation)) return ctx;
  const outcome = await ctx.adopt(ctx.task, ctx.generation);
  if (outcome === 'timeout') return settled(ctx, 'recovery-await-timeout');
  if (outcome === true) return settled(ctx, 'orphan-adopted');
  return ctx;
}

export function finalizeRedispatch(
  ctx: PostApprovalRecoveryAdmissionCtx
): PostApprovalRecoveryAdmissionResult {
  if (ctx.result !== null) return ctx.result;
  ctx.clearBypass(ctx.task.id);
  return { value: { action: 'redispatch', task: ctx.task } };
}

const recoveryAdmissionRun = (
  superpipe<{ admitted: (ctx: PostApprovalRecoveryAdmissionCtx) => boolean }>({
    admitted: (ctx: PostApprovalRecoveryAdmissionCtx): boolean => ctx.result !== null,
  })('post-approval-recovery-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadAdmissionFacts, 'ctx', 'ctx')
  .pipe(gateTaskEligibility, 'ctx', 'ctx')
  .pipe('!admitted', 'ctx')
  .pipe(attemptWorkerRevival, 'ctx', 'ctx')
  .pipe('!admitted', 'ctx')
  .pipe(attemptOrphanAdoption, 'ctx', 'ctx')
  .pipe('!admitted', 'ctx')
  .endAsync('ctx');

export async function runPostApprovalRecoveryAdmission(
  input: PostApprovalRecoveryAdmissionDeps & {
    task: SpaceTask;
    generation: number;
    now: number;
  }
): Promise<PostApprovalRecoveryAdmissionResult> {
  const ctx = (await recoveryAdmissionRun({
    ...input,
    dispatchDead: false,
    unrecordedStale: false,
    reviveBypassed: false,
    result: null,
  })) as PostApprovalRecoveryAdmissionCtx;
  return finalizeRedispatch(ctx);
}
