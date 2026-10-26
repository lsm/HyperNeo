import superpipe, { type PipelineAPI } from 'superpipe';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { releaseRateLimitDeliveries } from '../../storage/repositories/rate-limit-retry-write.ts';
import type { Database } from '../../storage/sqlite-compat.ts';

export interface RateLimitManualRetryDb {
  getSession(sessionId: string): { processingState?: string | null } | null | undefined;
  getJobQueueRepo?: () =>
    | {
        getActiveDeliveryMessageUuid?: (sessionId: string) => string | null;
        rescheduleDelivery?: (sessionId: string, messageUuid: string, runAt: number) => boolean;
        rescheduleSessionDeliveries?: (sessionId: string, runAt: number) => boolean;
      }
    | null
    | undefined;
}

export interface RateLimitManualRetryCtx {
  db: RateLimitManualRetryDb & { getDatabase: () => Database };
  sessionId: string;
  episodeMessageUuid?: string;
  clearCooldown: () => Promise<void>;
  cleared: boolean;
  released: boolean;
}

export type RateLimitPersistedCooldownRead =
  | { state: 'cooldown'; messageId?: string }
  | { state: 'inactive' }
  | { state: 'unreadable' };

export function readRateLimitPersistedCooldown(
  db: RateLimitManualRetryDb,
  sessionId: string
): RateLimitPersistedCooldownRead {
  const persistedState = db.getSession(sessionId)?.processingState;
  if (!persistedState) return { state: 'inactive' };
  try {
    const parsed = JSON.parse(persistedState) as { status?: string; messageId?: string };
    if (parsed.status !== 'rate_limit_cooldown') return { state: 'inactive' };
    return { state: 'cooldown', messageId: parsed.messageId };
  } catch {
    return { state: 'unreadable' };
  }
}

async function clearPersistedCooldownStage(
  ctx: RateLimitManualRetryCtx
): Promise<RateLimitManualRetryCtx> {
  if (readRateLimitPersistedCooldown(ctx.db, ctx.sessionId).state === 'cooldown') {
    await ctx.clearCooldown();
  }
  return {
    ...ctx,
    cleared: readRateLimitPersistedCooldown(ctx.db, ctx.sessionId).state !== 'cooldown',
  };
}

async function releaseOwningDeliveryStage(
  ctx: RateLimitManualRetryCtx
): Promise<RateLimitManualRetryCtx> {
  if (!ctx.cleared) {
    return { ...ctx, released: false };
  }
  try {
    const released = await gatewayFor(ctx.db.getDatabase()).run(releaseRateLimitDeliveries, {
      sessionId: ctx.sessionId,
    });
    return { ...ctx, released };
  } catch {
    return { ...ctx, released: false };
  }
}

const rateLimitManualRetryPipeline = (
  superpipe({
    settled: (ctx: RateLimitManualRetryCtx) => ctx.released,
    cleared: (ctx: RateLimitManualRetryCtx) => ctx.cleared,
  })('rate-limit-manual-retry') as PipelineAPI
)
  .input(['ctx'])
  .pipe(clearPersistedCooldownStage, 'ctx', 'ctx')
  .pipe(releaseOwningDeliveryStage, 'ctx', 'ctx')
  .endAsync('ctx');

const runManualRetry = rateLimitManualRetryPipeline as (
  input: RateLimitManualRetryCtx
) => Promise<RateLimitManualRetryCtx>;

export async function runRateLimitManualRetry(
  input: Omit<RateLimitManualRetryCtx, 'cleared' | 'released'>
): Promise<boolean> {
  const outcome = await runManualRetry({ ...input, cleared: false, released: false });
  return outcome.released && outcome.cleared;
}
