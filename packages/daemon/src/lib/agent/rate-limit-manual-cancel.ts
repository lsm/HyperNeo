import superpipe, { type PipelineAPI } from 'superpipe';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { cancelRateLimitDelivery } from '../../storage/repositories/rate-limit-cancel-write.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import {
  readRateLimitPersistedCooldown,
  type RateLimitManualRetryDb,
} from './rate-limit-manual-retry.ts';

export interface RateLimitManualCancelDb extends RateLimitManualRetryDb {
  getDatabase: () => Database;
}

export interface RateLimitManualCancelCtx {
  db: RateLimitManualCancelDb;
  sessionId: string;
  getLiveEpisodeMessageUuid: () => string | undefined;
  getPersistedArmMessageUuid: () => string | undefined;
  cancelWatchdog: () => void;
  isInMemoryCooldown: () => boolean;
  clearCooldown: () => Promise<void> | void;
  publishStatusesFailed: (messageIds: string[]) => Promise<void> | void;
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

export async function settleOwningDeliveryStage(
  ctx: RateLimitManualCancelCtx
): Promise<RateLimitManualCancelCtx> {
  try {
    const settledDbId = await gatewayFor(ctx.db.getDatabase()).call(
      cancelRateLimitDelivery,
      'cancel',
      ctx.sessionId,
      ctx.episodeMessageUuid
    );
    if (settledDbId) await ctx.publishStatusesFailed([settledDbId]);
  } catch (error) {
    ctx.onDeliveryCancelError(error);
  }
  return ctx;
}

export async function clearCooldownStage(
  ctx: RateLimitManualCancelCtx
): Promise<RateLimitManualCancelCtx> {
  if (ctx.cooldownClearPending) {
    await ctx.clearCooldown();
  }
  return ctx;
}

const runRateLimitManualCancelPipeline = (superpipe()('rate-limit-manual-cancel') as PipelineAPI)
  .input(['ctx'])
  .pipe(captureEpisodeStage, 'ctx', 'ctx')
  .pipe(settleOwningDeliveryStage, 'ctx', 'ctx')
  .pipe(clearCooldownStage, 'ctx', 'ctx')
  .endAsync('ctx') as (ctx: RateLimitManualCancelCtx) => Promise<RateLimitManualCancelCtx>;

export async function runRateLimitManualCancel(
  input: Omit<RateLimitManualCancelCtx, 'episodeMessageUuid' | 'cooldownClearPending'>
): Promise<void> {
  await runRateLimitManualCancelPipeline({ ...input, cooldownClearPending: false });
}
