import superpipe, { type PipelineAPI } from 'superpipe';

export interface RateLimitManualRetryDb {
  getSession(sessionId: string): { processingState?: string | null } | null | undefined;
  getJobQueueRepo?: () =>
    | {
        getActiveDeliveryRole?: (sessionId: string, messageUuid: string) => 'turn' | 'steer' | null;
        getActiveTurnDeliveryMessageUuid?: (sessionId: string) => string | null;
        rescheduleDelivery?: (sessionId: string, messageUuid: string, runAt: number) => boolean;
      }
    | null
    | undefined;
}

export interface RateLimitManualRetryCtx {
  db: RateLimitManualRetryDb;
  sessionId: string;
  episodeMessageUuid?: string;
  clearCooldown: () => Promise<void>;
  cleared: boolean;
  released: boolean;
}

function readPersistedCooldownActive(ctx: RateLimitManualRetryCtx): boolean {
  const persistedState = ctx.db.getSession(ctx.sessionId)?.processingState;
  if (!persistedState) return false;
  try {
    const parsed = JSON.parse(persistedState) as { status?: string };
    return parsed.status === 'rate_limit_cooldown';
  } catch {
    return false;
  }
}

export function resolveRateLimitEpisodeDeliveryUuid(
  db: RateLimitManualRetryDb,
  sessionId: string,
  episodeMessageId: string | undefined
): string | undefined {
  const jobQueue = db.getJobQueueRepo?.();
  if (episodeMessageId === undefined) {
    return jobQueue?.getActiveTurnDeliveryMessageUuid?.(sessionId) ?? undefined;
  }
  if (jobQueue?.getActiveDeliveryRole?.(sessionId, episodeMessageId) === 'steer') {
    return jobQueue?.getActiveTurnDeliveryMessageUuid?.(sessionId) ?? episodeMessageId;
  }
  return episodeMessageId;
}

async function clearPersistedCooldownStage(
  ctx: RateLimitManualRetryCtx
): Promise<RateLimitManualRetryCtx> {
  if (readPersistedCooldownActive(ctx)) {
    await ctx.clearCooldown();
  }
  return { ...ctx, cleared: !readPersistedCooldownActive(ctx) };
}

async function releaseOwningDeliveryStage(
  ctx: RateLimitManualRetryCtx
): Promise<RateLimitManualRetryCtx> {
  const owningTurnMessageId = resolveRateLimitEpisodeDeliveryUuid(
    ctx.db,
    ctx.sessionId,
    ctx.episodeMessageUuid
  );
  if (!owningTurnMessageId) {
    return { ...ctx, released: true };
  }
  const released = ctx.db
    .getJobQueueRepo?.()
    ?.rescheduleDelivery?.(ctx.sessionId, owningTurnMessageId, Date.now());
  return { ...ctx, released: released !== false };
}

const rateLimitManualRetryPipeline = (
  superpipe({
    settled: (ctx: RateLimitManualRetryCtx) => ctx.released,
    cleared: (ctx: RateLimitManualRetryCtx) => ctx.cleared,
  })('rate-limit-manual-retry') as PipelineAPI
)
  .input(['ctx'])
  .pipe(clearPersistedCooldownStage, 'ctx', 'ctx')
  .pipe('!cleared', 'ctx')
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
