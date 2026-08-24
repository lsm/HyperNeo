import { createHash } from 'node:crypto';
import type { JobQueueProcessorSnapshot } from '../../storage/job-queue-processor.ts';
import { emitStructuredLogEvent } from '../logger.ts';

export type MessageDeliveryLifecycleEventName =
  | 'claim'
  | 'slot_acquired'
  | 'query_ready'
  | 'sdk_admitted'
  | 'first_sdk_response'
  | 'lease_renewed'
  | 'stale_reclaimed'
  | 'stale_reclaim_jitter_failed'
  | 'old_handler_aborted'
  | 'settled'
  | 'slot_released'
  | 'fenced_completion_rejected';

export interface MessageDeliveryLifecycleFields {
  jobId?: string;
  claimFingerprint?: string | null;
  queue?: string;
  slotClass?: 'capped' | 'exempt';
  sessionId?: string;
  messageUuid?: string;
  role?: string;
  generation?: number;
  stage?: string;
  elapsedMs?: number;
  outcome?: string;
  reason?: string;
  responseType?: string;
}

export function fingerprintDeliveryClaim(claimToken: string | null): string | null {
  if (!claimToken) return null;
  return createHash('sha256').update(claimToken).digest('hex').slice(0, 16);
}

export function emitMessageDeliveryLifecycleEvent(
  event: MessageDeliveryLifecycleEventName,
  fields: MessageDeliveryLifecycleFields
): void {
  try {
    const metadata: Record<string, string | number | boolean | null> = { event };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) metadata[key] = value;
    }
    emitStructuredLogEvent({
      level:
        event === 'fenced_completion_rejected' || event === 'stale_reclaim_jitter_failed'
          ? 'warn'
          : 'info',
      args: ['message_delivery.lifecycle'],
      source: 'logger',
      module: 'hyperneo:daemon:message-delivery.lifecycle',
      metadata,
    });
  } catch {}
}

export type ReclaimSkipOutcome =
  | 'alreadyConsumed'
  | 'alreadySubmitted'
  | 'noContent'
  | 'turn_terminated';

export interface DeliveryMetricsSnapshot {
  feedsObserved: number;
  duplicateFeedCount: number;
  duplicateUuids: string[];
  reclaimSkips: Record<ReclaimSkipOutcome, number>;
  residualWindowP50: number | null;
  residualWindowP99: number | null;
  residualWindowSamples: number;
  deadLetters: number;
  zeroProgressWedges: number;
}

export interface MessageDeliveryDiagnostics {
  lane: string;
  statusCounts: Record<string, number>;
  staleProcessing: number;
  activeProcessing: number;
  oldestProcessingLeaseAgeMs: number | null;
  processor: JobQueueProcessorSnapshot;
  metrics: DeliveryMetricsSnapshot;
}

const RESIDUAL_WINDOW_SAMPLE_CAP = 1000;
const DUPLICATE_UUID_CAP = 100;
const RECENT_FEED_WINDOW = 1000;

export class DeliveryMetrics {
  private feedsObserved = 0;
  private recentFeeds = new Map<string, number>();
  private duplicateUuids: string[] = [];
  private reclaimSkips: Record<ReclaimSkipOutcome, number> = {
    alreadyConsumed: 0,
    alreadySubmitted: 0,
    noContent: 0,
    turn_terminated: 0,
  };
  private residualWindows: number[] = [];
  private deadLetters = 0;
  private zeroProgressWedges = 0;

  recordFeed(messageUuid: string): void {
    this.feedsObserved++;
    const prior = this.recentFeeds.get(messageUuid) ?? 0;
    if (prior >= 1) {
      if (!this.duplicateUuids.includes(messageUuid)) {
        this.duplicateUuids.push(messageUuid);
        if (this.duplicateUuids.length > DUPLICATE_UUID_CAP) this.duplicateUuids.shift();
      }
    }
    this.recentFeeds.delete(messageUuid);
    this.recentFeeds.set(messageUuid, prior + 1);
    if (this.recentFeeds.size > RECENT_FEED_WINDOW) {
      const oldest = this.recentFeeds.keys().next().value as string | undefined;
      if (oldest !== undefined) this.recentFeeds.delete(oldest);
    }
  }

  forgetFeed(messageUuid: string): void {
    this.recentFeeds.delete(messageUuid);
  }

  recordReclaimSkip(outcome: ReclaimSkipOutcome): void {
    this.reclaimSkips[outcome]++;
  }

  recordResidualWindow(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.residualWindows.push(ms);
    if (this.residualWindows.length > RESIDUAL_WINDOW_SAMPLE_CAP) {
      this.residualWindows.shift();
    }
  }

  recordDeadLetter(): void {
    this.deadLetters++;
  }

  recordZeroProgressWedge(): void {
    this.zeroProgressWedges++;
  }

  snapshot(): DeliveryMetricsSnapshot {
    return {
      feedsObserved: this.feedsObserved,
      duplicateFeedCount: this.duplicateUuids.length,
      duplicateUuids: [...this.duplicateUuids],
      reclaimSkips: { ...this.reclaimSkips },
      residualWindowP50: percentile(this.residualWindows, 0.5),
      residualWindowP99: percentile(this.residualWindows, 0.99),
      residualWindowSamples: this.residualWindows.length,
      deadLetters: this.deadLetters,
      zeroProgressWedges: this.zeroProgressWedges,
    };
  }
}

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export const deliveryMetrics = new DeliveryMetrics();
