import superpipe, { type PipelineAPI } from 'superpipe';
import {
  readRateLimitPersistedCooldown,
  resolveRateLimitEpisodeDeliveryUuid,
  type RateLimitManualRetryDb,
} from './rate-limit-manual-retry.ts';

export interface RateLimitManualCancelDb extends RateLimitManualRetryDb {
  getJobQueueRepo: () =>
    | {
        getActiveDeliveryRole?: (sessionId: string, messageUuid: string) => 'turn' | 'steer' | null;
        getActiveTurnDeliveryMessageUuid?: (sessionId: string) => string | null;
        getActiveDeliveryBatchUuids?: (sessionId: string, kickoffUuid: string) => string[] | null;
        cancelDelivery: (sessionId: string, messageUuid: string) => boolean;
        rescheduleSessionDeliveries?: (sessionId: string, runAt: number) => boolean;
      }
    | null
    | undefined;
  getSDKMessageRepo?: () =>
    | { markDeliveryFailedByUuid?: (sessionId: string, uuid: string) => string | null }
    | null
    | undefined;
}

export interface RateLimitManualCancelCtx {
  db: RateLimitManualCancelDb;
  sessionId: string;
  getLiveEpisodeMessageUuid: () => string | undefined;
  getPersistedArmMessageUuid: () => string | undefined;
  cancelWatchdog: () => void;
  isInMemoryCooldown: () => boolean;
  clearCooldown: () => void;
  publishStatusesFailed: (messageIds: string[]) => void;
  onPersistedCooldownReadError: () => void;
  onDeliveryCancelError: (error: unknown) => void;
  episodeMessageUuid?: string;
  cooldownClearPending: boolean;
}

export function captureEpisodeStage(ctx: RateLimitManualCancelCtx): RateLimitManualCancelCtx {
  const liveEpisodeMessageUuid = ctx.getLiveEpisodeMessageUuid();
  const persistedArmMessageUuid = ctx.getPersistedArmMessageUuid();
  ctx.cancelWatchdog();
  const inMemoryCooldown = ctx.isInMemoryCooldown();
  const persisted = readRateLimitPersistedCooldown(ctx.db, ctx.sessionId);
  if (persisted.state === 'unreadable') {
    ctx.onPersistedCooldownReadError();
  }
  const persistedCooldown = persisted.state === 'cooldown';
  let episodeMessageUuid = persistedArmMessageUuid;
  if (persistedCooldown && !episodeMessageUuid && persisted.messageId) {
    episodeMessageUuid = persisted.messageId;
  }
  return {
    ...ctx,
    episodeMessageUuid: liveEpisodeMessageUuid ?? episodeMessageUuid,
    cooldownClearPending: inMemoryCooldown || persistedCooldown,
  };
}

export function settleOwningDeliveryStage(ctx: RateLimitManualCancelCtx): RateLimitManualCancelCtx {
  const owningTurnMessageUuid = resolveRateLimitEpisodeDeliveryUuid(
    ctx.db,
    ctx.sessionId,
    ctx.episodeMessageUuid
  );
  if (!owningTurnMessageUuid) return ctx;
  try {
    const jobQueue = ctx.db.getJobQueueRepo();
    const sdkRepo = ctx.db.getSDKMessageRepo?.();
    const batchUuids = jobQueue?.getActiveDeliveryBatchUuids?.(
      ctx.sessionId,
      owningTurnMessageUuid
    );
    jobQueue?.cancelDelivery(ctx.sessionId, owningTurnMessageUuid);
    const uuidsToSettle =
      batchUuids && batchUuids.length > 0 ? batchUuids : [owningTurnMessageUuid];
    const settledDbIds: string[] = [];
    for (const uuid of uuidsToSettle) {
      const settledDbId = sdkRepo?.markDeliveryFailedByUuid?.(ctx.sessionId, uuid);
      if (settledDbId) settledDbIds.push(settledDbId);
    }
    if (settledDbIds.length > 0) {
      ctx.publishStatusesFailed(settledDbIds);
    }
    jobQueue?.rescheduleSessionDeliveries?.(ctx.sessionId, Date.now());
  } catch (error) {
    ctx.onDeliveryCancelError(error);
  }
  return ctx;
}

export function clearCooldownStage(ctx: RateLimitManualCancelCtx): RateLimitManualCancelCtx {
  if (ctx.cooldownClearPending) {
    ctx.clearCooldown();
  }
  return ctx;
}

const runRateLimitManualCancelPipeline = (superpipe()('rate-limit-manual-cancel') as PipelineAPI)
  .input(['ctx'])
  .pipe(captureEpisodeStage, 'ctx', 'ctx')
  .pipe(settleOwningDeliveryStage, 'ctx', 'ctx')
  .pipe(clearCooldownStage, 'ctx', 'ctx')
  .end('ctx') as (ctx: RateLimitManualCancelCtx) => RateLimitManualCancelCtx;

export function runRateLimitManualCancel(
  input: Omit<RateLimitManualCancelCtx, 'episodeMessageUuid' | 'cooldownClearPending'>
): void {
  runRateLimitManualCancelPipeline({ ...input, cooldownClearPending: false });
}
