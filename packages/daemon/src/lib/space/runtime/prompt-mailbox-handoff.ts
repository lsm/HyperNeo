import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  activatePrompts,
  ensurePrompt,
  retryPrompt,
  verifyPromptContent,
} from '../../agent/message-delivery-outbox.ts';
import type { MessageDeliveryOrigin } from '../../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

export type PromptHandoffMechanism = 'retry' | 'activate' | 'ensure';

export interface PromptHandoffRow {
  sendStatus: string;
}

export interface PromptHandoffDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface PromptHandoffTarget {
  sessionId: string;
  messageId: string;
  message: SDKUserMessage;
  origin: MessageDeliveryOrigin;
  messageOrigin?: MessageOrigin;
}

export interface PromptHandoffStageOutcome {
  dbId: string;
  changed: boolean;
}

export interface EnsureHandoffStageOutcome extends PromptHandoffStageOutcome {
  advanced: boolean;
}

export function planHandoffMechanism(
  existing: PromptHandoffRow | null | undefined
): PromptHandoffMechanism {
  if (existing?.sendStatus === 'failed') return 'retry';
  if (existing?.sendStatus === 'deferred') return 'activate';
  return 'ensure';
}

export function resolveDeliverableHandoff(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): PromptHandoffStageOutcome {
  const settledDbId = deps.sdkMessageRepo.getSettledDeliveryMessageId(
    target.sessionId,
    target.messageId
  );
  if (settledDbId !== null) {
    return { dbId: settledDbId, changed: false };
  }
  const dbIds = deps.sdkMessageRepo.getDeliveryMessageIdsByUuids(target.sessionId, [
    target.messageId,
  ]);
  return { dbId: dbIds[0] ?? target.messageId, changed: false };
}

export function hasSettledHandoffRow(
  deps: PromptHandoffDeps,
  target: Pick<PromptHandoffTarget, 'sessionId' | 'messageId'>
): boolean {
  if (deps.sdkMessageRepo.hasConsumptionEvidence(target.sessionId, target.messageId)) return true;
  return (
    deps.sdkMessageRepo.getSettledDeliveryMessageId(target.sessionId, target.messageId) !== null
  );
}

export async function retryFailedPromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): Promise<PromptHandoffStageOutcome | null> {
  if (hasSettledHandoffRow(deps, target)) {
    return resolveDeliverableHandoff(deps, target);
  }
  const retried = await retryPrompt({
    db: deps.db,
    jobQueue: deps.jobQueue,
    sdkMessageRepo: deps.sdkMessageRepo,
    sessionId: target.sessionId,
    messageUuid: target.messageId,
    origin: target.origin,
  });
  if (retried === null) {
    if (hasSettledHandoffRow(deps, target)) {
      return resolveDeliverableHandoff(deps, target);
    }
    return null;
  }
  return { dbId: retried.dbId, changed: true };
}

export async function activateDeferredPromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): Promise<PromptHandoffStageOutcome | null> {
  const { activated } = await activatePrompts({
    db: deps.db,
    jobQueue: deps.jobQueue,
    sessionId: target.sessionId,
    messageUuids: [target.messageId],
    origin: target.origin,
  });
  const entry = activated[0];
  if (!entry) {
    if (hasSettledHandoffRow(deps, target)) {
      return resolveDeliverableHandoff(deps, target);
    }
    return null;
  }
  return { dbId: entry.dbId, changed: true };
}

export function ensurePromptIntoMailbox(
  deps: PromptHandoffDeps,
  target: PromptHandoffTarget
): EnsureHandoffStageOutcome {
  const ensured = ensurePrompt({
    db: deps.db,
    sdkMessageRepo: deps.sdkMessageRepo,
    jobQueue: deps.jobQueue,
    sessionId: target.sessionId,
    message: target.message,
    origin: target.messageOrigin,
    delivery: { origin: target.origin },
  });
  return {
    dbId: ensured.dbMessageId,
    changed: ensured.created,
    advanced: ensured.created || ensured.activated,
  };
}

export interface MailboxHandoffStateManager {
  setQueuedIfIdle(messageId: string): Promise<boolean>;
}

export interface MailboxHandoffArgs {
  deps: PromptHandoffDeps;
  target: PromptHandoffTarget;
  stateManager?: MailboxHandoffStateManager;
  publishStatusChanged?: (sessionId: string, dbId: string, status: 'enqueued') => Promise<void>;
}

export type MailboxHandoffOutcome =
  | { state: 'enqueued'; dbId: string; changed: boolean; advanced: boolean }
  | { state: 'settled'; dbId: string }
  | { state: 'stale' };

interface MailboxHandoffCtx extends MailboxHandoffArgs {
  mechanism?: PromptHandoffMechanism;
  applied?: EnsureHandoffStageOutcome | null;
  outcome?: MailboxHandoffOutcome;
}

function planHandoffStage(ctx: MailboxHandoffCtx): MailboxHandoffCtx {
  const row = ctx.deps.sdkMessageRepo.getDeliveryContent(
    ctx.target.sessionId,
    ctx.target.messageId
  );
  return { ...ctx, mechanism: planHandoffMechanism(row ?? null) };
}

export function verifyHandoffContent(ctx: MailboxHandoffCtx): MailboxHandoffCtx {
  verifyPromptContent({
    db: ctx.deps.db,
    sessionId: ctx.target.sessionId,
    messageUuid: ctx.target.messageId,
    message: ctx.target.message,
  });
  return ctx;
}

async function dispatchHandoffMechanism(
  ctx: MailboxHandoffCtx,
  mechanism: PromptHandoffMechanism
): Promise<EnsureHandoffStageOutcome | null> {
  if (mechanism === 'retry') {
    const retried = await retryFailedPromptIntoMailbox(ctx.deps, ctx.target);
    return retried === null ? null : { ...retried, advanced: retried.changed };
  }
  if (mechanism === 'activate') {
    const activated = await activateDeferredPromptIntoMailbox(ctx.deps, ctx.target);
    return activated === null ? null : { ...activated, advanced: activated.changed };
  }
  return ensurePromptIntoMailbox(ctx.deps, ctx.target);
}

export async function applyHandoffMechanism(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  const mechanism = ctx.mechanism ?? 'ensure';
  const planned = await dispatchHandoffMechanism(ctx, mechanism);
  if (planned !== null && (mechanism !== 'ensure' || planned.advanced)) {
    return { ...ctx, applied: planned };
  }
  const fresh = ctx.deps.sdkMessageRepo.getDeliveryContent(
    ctx.target.sessionId,
    ctx.target.messageId
  );
  return { ...ctx, applied: await dispatchHandoffMechanism(ctx, planHandoffMechanism(fresh)) };
}

export function settleHandoffOutcome(ctx: MailboxHandoffCtx): MailboxHandoffCtx {
  const applied = ctx.applied ?? null;
  if (applied === null) return { ...ctx, outcome: { state: 'stale' } };
  if (hasSettledHandoffRow(ctx.deps, ctx.target)) {
    const deliverable = resolveDeliverableHandoff(ctx.deps, ctx.target);
    return { ...ctx, outcome: { state: 'settled', dbId: deliverable.dbId } };
  }
  return {
    ...ctx,
    outcome: {
      state: 'enqueued',
      dbId: applied.dbId,
      changed: applied.changed,
      advanced: applied.advanced,
    },
  };
}

export async function markQueuedIfIdle(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  const outcome = ctx.outcome;
  if (!ctx.stateManager || outcome?.state !== 'enqueued' || !outcome.advanced) return ctx;
  try {
    await ctx.stateManager.setQueuedIfIdle(ctx.target.messageId);
  } catch {}
  return ctx;
}

export async function publishEnqueuedIfChanged(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  const outcome = ctx.outcome;
  if (!ctx.publishStatusChanged || outcome?.state !== 'enqueued' || !outcome.changed) return ctx;
  try {
    await ctx.publishStatusChanged(ctx.target.sessionId, outcome.dbId, 'enqueued');
  } catch {}
  return ctx;
}

const runHandoffPromptToMailbox = (superpipe({})('handoff-prompt-to-mailbox') as PipelineAPI)
  .input(['ctx'])
  .pipe(planHandoffStage, 'ctx', 'ctx')
  .pipe(verifyHandoffContent, 'ctx', 'ctx')
  .pipe(applyHandoffMechanism, 'ctx', 'ctx')
  .pipe(settleHandoffOutcome, 'ctx', 'ctx')
  .pipe(markQueuedIfIdle, 'ctx', 'ctx')
  .pipe(publishEnqueuedIfChanged, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: MailboxHandoffCtx) => Promise<MailboxHandoffCtx>;

export async function handoffPromptToMailbox(
  args: MailboxHandoffArgs
): Promise<MailboxHandoffOutcome> {
  const ctx = await runHandoffPromptToMailbox(args);
  return ctx.outcome ?? { state: 'stale' };
}
