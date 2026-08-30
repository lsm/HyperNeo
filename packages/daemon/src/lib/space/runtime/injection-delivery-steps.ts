import type { MessageOrigin } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  activatePrompts,
  ensurePrompt,
  retryPrompt,
} from '../../../lib/agent/message-delivery-outbox.ts';
import type {
  ContextClearBoundaryOwner,
  MessageDeliveryOrigin,
  MessageDeliveryRole,
} from '../../../lib/agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';

export type InjectionDeliveryStatus = 'enqueued' | 'deferred' | 'failed';

export interface InjectionDeliveryRowDeps {
  publishStatusChanged(
    sessionId: string,
    dbId: string,
    status: InjectionDeliveryStatus
  ): Promise<void>;
  saveUserMessage(
    sessionId: string,
    message: SDKUserMessage,
    sendStatus: 'enqueued' | 'deferred',
    origin?: MessageOrigin
  ): string;
  reopenDeliveryByUuid(sessionId: string, uuid: string): string | null;
  markDeliveryDeferredByUuid(sessionId: string, uuid: string): string | null;
}

export async function reopenFailedDeliveryRow(
  deps: InjectionDeliveryRowDeps,
  sessionId: string,
  messageId: string
): Promise<void> {
  const reopenedDbId = deps.reopenDeliveryByUuid(sessionId, messageId);
  if (reopenedDbId) {
    await deps.publishStatusChanged(sessionId, reopenedDbId, 'enqueued');
  }
}

export async function flipDeliveryRowToDeferred(
  deps: InjectionDeliveryRowDeps,
  sessionId: string,
  messageId: string
): Promise<string | null> {
  const flippedDbId = deps.markDeliveryDeferredByUuid(sessionId, messageId);
  if (flippedDbId) {
    await deps.publishStatusChanged(sessionId, flippedDbId, 'deferred');
  }
  return flippedDbId;
}

export interface SettleDeliveryRowStatusArgs {
  sessionId: string;
  message: SDKUserMessage;
  messageId: string;
  rowExists: boolean;
  status: 'enqueued' | 'deferred';
  origin?: MessageOrigin;
}

export async function settleDeliveryRowStatus(
  deps: InjectionDeliveryRowDeps,
  args: SettleDeliveryRowStatusArgs
): Promise<string> {
  const dbId = args.rowExists
    ? args.messageId
    : deps.saveUserMessage(args.sessionId, args.message, args.status, args.origin);
  await deps.publishStatusChanged(args.sessionId, dbId, args.status);
  return dbId;
}

export interface InjectionDeliveryTargetSession {
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  getSessionData?: () => { config?: { provider?: string } };
}

export interface InjectDeliveryBranchDeps extends InjectionDeliveryRowDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
}

export interface MailboxHandoffArgs {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
  jobQueue: JobQueueRepository;
  sessionId: string;
  messageId: string;
  message: SDKUserMessage;
  origin: MessageDeliveryOrigin;
  messageOrigin?: MessageOrigin;
  existing?: { sendStatus: string } | null;
  publishEnqueued(sessionId: string, dbId: string): Promise<void>;
  setQueuedIfIdle?(messageId: string): Promise<boolean>;
}

interface MailboxHandoffCtx extends MailboxHandoffArgs {
  mechanism: 'retry' | 'activate' | 'ensure';
  handoff: { dbId: string; role: MessageDeliveryRole | null; changed: boolean } | null;
}

function planHandoffMechanism(ctx: MailboxHandoffCtx): MailboxHandoffCtx {
  const mechanism =
    ctx.existing?.sendStatus === 'failed'
      ? 'retry'
      : ctx.existing?.sendStatus === 'deferred'
        ? 'activate'
        : 'ensure';
  return { ...ctx, mechanism, handoff: null };
}

function alreadyHandledHandoff(ctx: MailboxHandoffCtx, targetStatus: string): MailboxHandoffCtx {
  const current = ctx.sdkMessageRepo.getDeliveryContent(ctx.sessionId, ctx.messageId);
  if (current === null || current === undefined || current.sendStatus === targetStatus) {
    throw new Error(
      `prompt handoff: no ${targetStatus} row to advance for ${ctx.sessionId}/${ctx.messageId}`
    );
  }
  const dbIds = ctx.sdkMessageRepo.getDeliveryMessageIdsByUuids(ctx.sessionId, [ctx.messageId]);
  return { ...ctx, handoff: { dbId: dbIds[0] ?? ctx.messageId, role: null, changed: false } };
}

async function applyRetryHandoff(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  if (ctx.mechanism !== 'retry') return ctx;
  const retried = await retryPrompt({
    db: ctx.db,
    jobQueue: ctx.jobQueue,
    sdkMessageRepo: ctx.sdkMessageRepo,
    sessionId: ctx.sessionId,
    messageUuid: ctx.messageId,
    origin: ctx.origin,
  });
  if (retried === null) {
    return alreadyHandledHandoff(ctx, 'failed');
  }
  return { ...ctx, handoff: { dbId: retried.dbId, role: retried.role, changed: true } };
}

async function applyActivateHandoff(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  if (ctx.mechanism !== 'activate') return ctx;
  const { activated } = await activatePrompts({
    db: ctx.db,
    jobQueue: ctx.jobQueue,
    sessionId: ctx.sessionId,
    messageUuids: [ctx.messageId],
    origin: ctx.origin,
  });
  const entry = activated[0];
  if (!entry) {
    return alreadyHandledHandoff(ctx, 'deferred');
  }
  return { ...ctx, handoff: { dbId: entry.dbId, role: entry.role, changed: true } };
}

function applyEnsureHandoff(ctx: MailboxHandoffCtx): MailboxHandoffCtx {
  if (ctx.mechanism !== 'ensure') return ctx;
  const ensured = ensurePrompt({
    db: ctx.db,
    sdkMessageRepo: ctx.sdkMessageRepo,
    jobQueue: ctx.jobQueue,
    sessionId: ctx.sessionId,
    message: ctx.message,
    origin: ctx.messageOrigin,
    delivery: { origin: ctx.origin },
  });
  return {
    ...ctx,
    handoff: { dbId: ensured.dbMessageId, role: ensured.role, changed: ensured.created },
  };
}

async function markQueuedIfTurn(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  if (ctx.handoff?.role !== 'turn') return ctx;
  try {
    await ctx.setQueuedIfIdle?.(ctx.messageId);
  } catch {}
  return ctx;
}

async function publishEnqueuedIfChanged(ctx: MailboxHandoffCtx): Promise<MailboxHandoffCtx> {
  if (ctx.handoff?.changed !== true) return ctx;
  await ctx.publishEnqueued(ctx.sessionId, ctx.handoff.dbId);
  return ctx;
}

const runHandoff = (superpipe({})('prompt-mailbox-handoff') as PipelineAPI)
  .input(['ctx'])
  .pipe(planHandoffMechanism, 'ctx', 'ctx')
  .pipe(applyRetryHandoff, 'ctx', 'ctx')
  .pipe(applyActivateHandoff, 'ctx', 'ctx')
  .pipe(applyEnsureHandoff, 'ctx', 'ctx')
  .pipe(markQueuedIfTurn, 'ctx', 'ctx')
  .pipe(publishEnqueuedIfChanged, 'ctx', 'ctx')
  .endAsync('ctx') as (input: MailboxHandoffCtx) => Promise<MailboxHandoffCtx>;

export async function handoffPromptToMailbox(args: MailboxHandoffArgs): Promise<string> {
  const ctx = await runHandoff({ ...args, mechanism: 'ensure', handoff: null });
  if (ctx.handoff === null) {
    throw new Error(`prompt handoff: no mechanism applied for ${args.sessionId}/${args.messageId}`);
  }
  return ctx.handoff.dbId;
}

export interface DeliverInjectedMessageArgs {
  session: InjectionDeliveryTargetSession;
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  existing?: { sendStatus: string } | null;
  origin?: MessageOrigin;
  boundaryOwner?: ContextClearBoundaryOwner;
}

export async function deliverInjectedMessage(
  deps: InjectDeliveryBranchDeps,
  args: DeliverInjectedMessageArgs
): Promise<string> {
  try {
    return await handoffPromptToMailbox({
      db: deps.db,
      sdkMessageRepo: deps.sdkMessageRepo,
      jobQueue: deps.jobQueue,
      sessionId: args.sessionId,
      messageId: args.messageId,
      message: args.sdkUserMessage,
      origin: 'space_inject',
      messageOrigin: args.origin,
      existing:
        args.existing ?? deps.sdkMessageRepo.getDeliveryContent(args.sessionId, args.messageId),
      publishEnqueued: (sessionId, dbId) => deps.publishStatusChanged(sessionId, dbId, 'enqueued'),
      setQueuedIfIdle: args.session.stateManager?.setQueuedIfIdle.bind(args.session.stateManager),
    });
  } finally {
    args.boundaryOwner?.release();
  }
}
