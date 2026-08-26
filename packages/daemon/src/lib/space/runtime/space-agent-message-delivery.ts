import superpipe, { type PipelineAPI } from 'superpipe';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { Logger } from '../../logger.ts';
import {
  awaitDeliveryConsumptionTolerant,
  deliverAndMarkQueued,
  deliveryConsumptionTimeoutMs,
  waitForDeliveryConsumption,
  withSessionResetCoordination,
  type MessageDeliveryOrigin,
} from '../../agent/message-delivery.ts';

const log = new Logger('space-agent-delivery');

export interface LateSettlementRequest {
  sessionId: string;
  messageId: string;
  onConsumed: (settledSessionId: string) => void;
  onFailed?: () => void;
}

export interface SpaceAgentLateSettlementHandle {
  cancel(): void;
}

export interface SpaceAgentLateSettlementOwner {
  arm(request: LateSettlementRequest): SpaceAgentLateSettlementHandle;
}

export const LATE_SETTLE_HORIZON_MS = 12 * 60_000;

export class SpaceAgentLateSettlements implements SpaceAgentLateSettlementOwner {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly waiters = new Map<
    string,
    { handle: SpaceAgentLateSettlementHandle; release: () => void }
  >();
  private readonly disposeController = new AbortController();
  private disposed = false;

  disposeSignal(): AbortSignal {
    if (this.disposed) this.disposeController.abort();
    return this.disposeController.signal;
  }

  arm({
    sessionId,
    messageId,
    onConsumed,
    onFailed,
  }: LateSettlementRequest): SpaceAgentLateSettlementHandle {
    const key = `${sessionId}\u0000${messageId}`;
    this.waiters.get(key)?.release();
    if (this.disposed) return { cancel: () => {} };
    const late = waitForDeliveryConsumption(sessionId, messageId);
    let fired = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      clearTimeout(expiry);
      this.timers.delete(expiry!);
      this.waiters.delete(key);
      late.cancel();
    };
    this.timers.add(
      (expiry = setTimeout(() => {
        if (!fired) {
          fired = true;
        }
        release();
        try {
          onFailed?.();
        } catch (error) {
          log.warn(
            `late dead letter reconciliation failed for ${sessionId}/${messageId}: ` +
              `${error instanceof Error ? error.message : String(error)}`
          );
        }
      }, LATE_SETTLE_HORIZON_MS))
    );
    this.waiters.set(key, {
      release,
      handle: {
        cancel: () => {
          fired = true;
          release();
        },
      },
    });
    void late.promise.then(() => {
      release();
      if (fired) return;
      fired = true;
      try {
        onConsumed(sessionId);
      } catch (error) {
        log.warn(
          `delayed consumption settlement failed for ${sessionId}/${messageId}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    return this.waiters.get(key)!.handle;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeController.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [, watcher] of this.waiters) {
      watcher.handle.cancel();
    }
    this.waiters.clear();
  }
}
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';

export type SpaceAgentInjectionOutcome =
  | { state: 'delivered'; messageId: string; sessionId: string }
  | { state: 'queued'; messageId: string; sessionId: string }
  | { state: 'failed'; messageId: string; sessionId: string; error: string };

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
  onConsumed?: (settledSessionId: string) => void;
  onLateFailure?: () => void;
  lateSettlement?: SpaceAgentLateSettlementOwner;
  disposeSignal?: AbortSignal;
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
  return {
    ...ctx,
    outcome: { state: 'delivered', messageId: ctx.messageId, sessionId: ctx.sessionId },
  };
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
    signal: ctx.deps.disposeSignal,
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
    return { ...ctx, outcome: { state: 'delivered', messageId, sessionId } };
  }
  if (ctx.deps.onConsumed && ctx.deps.lateSettlement) {
    const lateArm = ctx.deps.lateSettlement.arm({
      sessionId,
      messageId,
      onConsumed: ctx.deps.onConsumed,
      onFailed: ctx.deps.onLateFailure,
    });
    const armed = readSettledStatus(ctx);
    if (armed === 'consumed') {
      lateArm.cancel();
      return { ...ctx, outcome: { state: 'delivered', messageId, sessionId } };
    }
    if (armed === 'failed') {
      lateArm.cancel();
      return {
        ...ctx,
        outcome: {
          state: 'failed',
          messageId,
          sessionId,
          error: 'delivery dead-lettered while awaiting consumption',
        },
      };
    }
    return { ...ctx, outcome: { state: 'queued', messageId, sessionId } };
  }
  const settled = readSettledStatus(ctx);
  if (settled === 'consumed') {
    return { ...ctx, outcome: { state: 'delivered', messageId, sessionId } };
  }
  if (settled === 'failed') {
    return {
      ...ctx,
      outcome: {
        state: 'failed',
        messageId,
        sessionId,
        error: 'delivery dead-lettered while awaiting consumption',
      },
    };
  }
  return { ...ctx, outcome: { state: 'queued', messageId, sessionId } };
}

function readSettledStatus(ctx: SpaceAgentDeliveryCtx): string | undefined {
  return ctx.deps.sdkMessageRepo.getDeliveryContent(ctx.sessionId, ctx.messageId)?.sendStatus;
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
      sessionId: args.sessionId,
      error: 'space-agent delivery ended without an outcome',
    }
  );
}
