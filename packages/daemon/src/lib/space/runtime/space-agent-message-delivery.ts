import superpipe, { type PipelineAPI } from 'superpipe';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import {
  awaitDeliveryConsumptionTolerant,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  waitForDeliveryConsumption,
  withSessionResetCoordination,
  type MessageDeliveryOrigin,
} from '../../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';

export type SpaceAgentInjectionOutcome =
  | { state: 'delivered'; messageId: string }
  | { state: 'queued'; messageId: string }
  | { state: 'failed'; messageId: string; error: string };

export interface SpaceAgentDeliveryDeps {
  sdkMessageRepo: {
    getDeliveryContent(
      sessionId: string,
      uuid: string
    ): { content: string | Array<{ type: string }>; sendStatus: string } | null;
    reopenDeliveryByUuid(sessionId: string, uuid: string): string | null;
    markDeliveryFailedByUuid(sessionId: string, uuid: string): string | null;
  };
  saveUserMessage(sessionId: string, message: SDKUserMessage, status: 'enqueued'): string;
  publishStatusChanged(
    sessionId: string,
    dbId: string,
    status: 'enqueued' | 'failed'
  ): Promise<void>;
  jobQueue: JobQueueRepository;
  stateManager?: {
    setQueuedIfIdle(messageId: string): Promise<boolean>;
    getState(): { status: string };
  };
  onConsumed?: () => void;
}

export interface SpaceAgentDeliveryInput {
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  provider?: string;
  origin?: MessageDeliveryOrigin;
}

interface SpaceAgentDeliveryCtx extends SpaceAgentDeliveryInput {
  deps: SpaceAgentDeliveryDeps;
  existing?: { sendStatus: string } | null;
  consumed?: boolean;
  outcome?: SpaceAgentInjectionOutcome;
}

function loadExistingRow(ctx: SpaceAgentDeliveryCtx): SpaceAgentDeliveryCtx {
  return {
    ...ctx,
    existing: ctx.deps.sdkMessageRepo.getDeliveryContent(ctx.sessionId, ctx.messageId),
  };
}

function shortCircuitConsumed(ctx: SpaceAgentDeliveryCtx): SpaceAgentDeliveryCtx {
  if (ctx.existing?.sendStatus !== 'consumed') return ctx;
  return { ...ctx, outcome: { state: 'delivered', messageId: ctx.messageId } };
}

async function persistOrReopenRow(ctx: SpaceAgentDeliveryCtx): Promise<SpaceAgentDeliveryCtx> {
  if (!ctx.existing) {
    const dbId = ctx.deps.saveUserMessage(ctx.sessionId, ctx.sdkUserMessage, 'enqueued');
    await ctx.deps.publishStatusChanged(ctx.sessionId, dbId, 'enqueued');
    return ctx;
  }
  if (ctx.existing.sendStatus === 'failed') {
    const reopenedDbId = ctx.deps.sdkMessageRepo.reopenDeliveryByUuid(ctx.sessionId, ctx.messageId);
    if (reopenedDbId) {
      await ctx.deps.publishStatusChanged(ctx.sessionId, reopenedDbId, 'enqueued');
    }
  }
  return ctx;
}

async function deliverAndAwaitConsumption(
  ctx: SpaceAgentDeliveryCtx
): Promise<SpaceAgentDeliveryCtx> {
  const { sessionId, messageId } = ctx;
  const outcome = await awaitDeliveryConsumptionTolerant({
    sessionId,
    messageUuid: messageId,
    timeoutMs: deliveryConsumptionTimeoutMs(ctx.provider),
    deliver: () =>
      withSessionResetCoordination(sessionId, async () =>
        deliverAndMarkQueued({
          jobQueue: ctx.deps.jobQueue,
          stateManager: ctx.deps.stateManager,
          sessionId,
          messageUuid: messageId,
          origin: ctx.origin ?? 'space_agent',
          onEnqueueFailure: () => {
            const failedDbId = ctx.deps.sdkMessageRepo.markDeliveryFailedByUuid(
              sessionId,
              messageId
            );
            if (failedDbId) {
              void ctx.deps.publishStatusChanged(sessionId, failedDbId, 'failed').catch(() => {});
            }
          },
        })
      ),
  });
  return { ...ctx, consumed: outcome.consumed };
}

async function classifyOutcome(ctx: SpaceAgentDeliveryCtx): Promise<SpaceAgentDeliveryCtx> {
  const { sessionId, messageId } = ctx;
  if (ctx.consumed) {
    return { ...ctx, outcome: { state: 'delivered', messageId } };
  }
  const settled = ctx.deps.sdkMessageRepo.getDeliveryContent(sessionId, messageId)?.sendStatus;
  if (settled === 'consumed') {
    return { ...ctx, outcome: { state: 'delivered', messageId } };
  }
  if (settled === 'failed') {
    return {
      ...ctx,
      outcome: {
        state: 'failed',
        messageId,
        error: 'delivery dead-lettered while awaiting consumption',
      },
    };
  }
  const late = waitForDeliveryConsumption(sessionId, messageId);
  void late.promise.then(() => ctx.deps.onConsumed?.());
  return { ...ctx, outcome: { state: 'queued', messageId } };
}

async function failDelivery(ctx: SpaceAgentDeliveryCtx): Promise<void> {
  const failedDbId = ctx.deps.sdkMessageRepo.markDeliveryFailedByUuid(ctx.sessionId, ctx.messageId);
  if (failedDbId) {
    await ctx.deps.publishStatusChanged(ctx.sessionId, failedDbId, 'failed').catch(() => {});
  }
}

function hasOutcome(ctx: SpaceAgentDeliveryCtx): boolean {
  return ctx.outcome !== undefined;
}

const run = (
  superpipe<{ hasOutcome: (ctx: SpaceAgentDeliveryCtx) => boolean }>({
    hasOutcome,
  })('space-agent-delivery') as PipelineAPI
)
  .input(['ctx'])
  .pipe(loadExistingRow, 'ctx', 'ctx')
  .pipe(shortCircuitConsumed, 'ctx', 'ctx')
  .pipe('!hasOutcome', 'ctx')
  .pipe(persistOrReopenRow, 'ctx', 'ctx')
  .pipe(deliverAndAwaitConsumption, 'ctx', 'ctx')
  .pipe(classifyOutcome, 'ctx', 'ctx')
  .error(failDelivery, ['ctx'])
  .endAsync('ctx') as (input: SpaceAgentDeliveryCtx) => Promise<SpaceAgentDeliveryCtx>;

export async function deliverSpaceAgentMessage(
  deps: SpaceAgentDeliveryDeps,
  args: SpaceAgentDeliveryInput
): Promise<SpaceAgentInjectionOutcome> {
  const ctx = await run({ ...args, deps });
  return (
    ctx.outcome ?? {
      state: 'failed',
      messageId: args.messageId,
      error: 'space-agent delivery ended without an outcome',
    }
  );
}
