import superpipe, { type PipelineAPI } from 'superpipe';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { Logger } from '../../logger.ts';
import {
  MESSAGE_DELIVERY_PARK_MS,
  signalDeliveryConsumed,
  waitForDeliveryConsumption,
  type MessageDeliveryOrigin,
} from '../../agent/message-delivery.ts';
import type { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import type { SDKMessageRepository } from '../../../storage/repositories/sdk-message-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import {
  PromptContentConflictError,
  verifyPromptContent,
} from '../../agent/message-delivery-outbox.ts';
import { handoffPromptToMailbox } from './injection-delivery-steps.ts';

const log = new Logger('space-agent-delivery');

export interface LateSettlementRequest {
  sessionId: string;
  messageId: string;
  onConsumed: (settledSessionId: string) => void;
  onFailed?: () => void;
  getSendStatus?: () => string | null | undefined;
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
  private disposed = false;

  arm({
    sessionId,
    messageId,
    onConsumed,
    onFailed,
    getSendStatus,
  }: LateSettlementRequest): SpaceAgentLateSettlementHandle {
    const key = `${sessionId}\u0000${messageId}`;
    this.waiters.get(key)?.release();
    if (this.disposed) return { cancel: () => {} };
    const late = waitForDeliveryConsumption(sessionId, messageId);
    let fired = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let statusPoll: ReturnType<typeof setInterval> | undefined;

    const release = (): void => {
      if (statusPoll) {
        clearInterval(statusPoll);
        statusPoll = undefined;
      }
      clearTimeout(expiry);
      this.timers.delete(expiry!);
      if (this.waiters.get(key)?.handle === handle) this.waiters.delete(key);
      late.cancel();
    };

    const settle = (outcome: 'consumed' | 'failed'): void => {
      if (fired) return;
      fired = true;
      release();
      try {
        if (outcome === 'consumed') {
          onConsumed(sessionId);
        } else {
          onFailed?.();
        }
      } catch (error) {
        log.warn(
          `late settlement ${outcome} failed for ${sessionId}/${messageId}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    const handle: SpaceAgentLateSettlementHandle = {
      cancel: () => {
        if (fired) return;
        fired = true;
        release();
      },
    };

    this.timers.add(
      (expiry = setTimeout(() => {
        settle('failed');
      }, LATE_SETTLE_HORIZON_MS))
    );
    this.waiters.set(key, { handle, release });

    void late.promise.then(() => settle('consumed'));

    if (getSendStatus) {
      const check = () => {
        try {
          const status = getSendStatus();
          if (status === 'consumed') {
            signalDeliveryConsumed(sessionId, messageId);
          } else if (status === 'failed') {
            settle('failed');
          }
        } catch {
          settle('failed');
        }
      };
      statusPoll = setInterval(check, MESSAGE_DELIVERY_PARK_MS);
      check();
    }

    return handle;
  }
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [, watcher] of this.waiters) {
      watcher.handle.cancel();
    }
    this.waiters.clear();
  }
}

export type SpaceAgentInjectionOutcome =
  | { state: 'accepted'; messageId: string; sessionId: string }
  | { state: 'failed'; messageId: string; sessionId: string; error: string };

export interface SpaceAgentDeliveryDeps {
  db: BunDatabase;
  sdkMessageRepo: SDKMessageRepository;
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
}

export interface SpaceAgentDeliveryInput {
  sessionId: string;
  messageId: string;
  sdkUserMessage: SDKUserMessage;
  origin?: MessageDeliveryOrigin;
}

interface SpaceAgentDeliveryCtx extends SpaceAgentDeliveryInput {
  deps: SpaceAgentDeliveryDeps;
  existing?: { sendStatus: string } | null;
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
  verifyPromptContent({
    db: ctx.deps.db,
    sessionId: ctx.sessionId,
    messageUuid: ctx.messageId,
    message: ctx.sdkUserMessage,
  });
  return {
    ...ctx,
    outcome: { state: 'accepted', messageId: ctx.messageId, sessionId: ctx.sessionId },
  };
}

async function enqueuePrompt(ctx: SpaceAgentDeliveryCtx): Promise<SpaceAgentDeliveryCtx> {
  await handoffPromptToMailbox({
    db: ctx.deps.db,
    sdkMessageRepo: ctx.deps.sdkMessageRepo,
    jobQueue: ctx.deps.jobQueue,
    sessionId: ctx.sessionId,
    messageId: ctx.messageId,
    message: ctx.sdkUserMessage,
    origin: ctx.origin ?? 'space_agent',
    existing: ctx.existing ?? null,
    publishEnqueued: (sessionId, dbId) =>
      ctx.deps.publishStatusChanged(sessionId, dbId, 'enqueued'),
    setQueuedIfIdle: ctx.deps.stateManager?.setQueuedIfIdle.bind(ctx.deps.stateManager),
  });
  return ctx;
}

function acceptOutcome(ctx: SpaceAgentDeliveryCtx): SpaceAgentDeliveryCtx {
  return {
    ...ctx,
    outcome: { state: 'accepted', messageId: ctx.messageId, sessionId: ctx.sessionId },
  };
}

async function failDelivery(ctx: SpaceAgentDeliveryCtx, error: unknown): Promise<void> {
  if (error instanceof PromptContentConflictError) {
    return;
  }
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
  .pipe(enqueuePrompt, 'ctx', 'ctx')
  .pipe(acceptOutcome, 'ctx', 'ctx')
  .error(failDelivery, ['ctx', 'error'])
  .endAsync('ctx') as (input: SpaceAgentDeliveryCtx) => Promise<SpaceAgentDeliveryCtx>;

export async function deliverSpaceAgentMessage(
  deps: SpaceAgentDeliveryDeps,
  args: SpaceAgentDeliveryInput
): Promise<SpaceAgentInjectionOutcome> {
  try {
    const ctx = await run({ ...args, deps });
    return (
      ctx.outcome ?? {
        state: 'failed',
        messageId: args.messageId,
        sessionId: args.sessionId,
        error: 'space-agent delivery ended without an outcome',
      }
    );
  } catch (error) {
    return {
      state: 'failed',
      messageId: args.messageId,
      sessionId: args.sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
