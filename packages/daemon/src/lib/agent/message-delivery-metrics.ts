/**
 * Delivery exactly-once observability (task #861 item 13).
 *
 * Delivery is **at-least-once**: a crash in the sub-ms window [SDK yield,
 * persisted consumed-flip] can still cause a duplicate re-feed, and the
 * `reclaimStale` + status-aware reload path intentionally re-drives stranded
 * messages. At-least-once ACCEPTS that duplicates can happen — these metrics are
 * how we know when the accepted failure actually occurs, and how we confirm the
 * duplicate-PREVENTION paths (synchronous consumed-flip, already-consumed skip)
 * are working.
 *
 * Three signals, all bounded in memory:
 *  (a) feed-count-per-UUID — `feedsObserved` is a plain counter of total SDK
 *      handoffs; duplicate detection is backed by a bounded recent-UUID window
 *      (LRU, `RECENT_FEED_WINDOW`). Any UUID handed off >1 time within the
 *      window is recorded in `duplicateUuids` — a GROUND-TRUTH duplicate (the
 *      SDK does not dedup). A duplicate whose first feed aged out of the window
 *      before the re-feed is not detected (an acceptable false-negative for a
 *      leading indicator; realistic reclaims happen within the stale window).
 *  (b) reclaim-skip outcomes — `reclaimSkips` counts claims that did NOT feed:
 *      `alreadyConsumed` (a consumed message re-claimed → reclaimStale skipped
 *      the re-feed) and `alreadySubmitted` (ACP submitted row re-claimed), plus
 *      `noContent` (content gone). `alreadyConsumed`/`alreadySubmitted` are the
 *      duplicates-PREVENTED leading indicator; a spike means crashes-during-turn
 *      are rising. (A fresh claim feeds an `enqueued` row — counted in
 *      `feedsObserved`, not here, so it cannot dilute the skip signal.)
 *      `turn_terminated` is a sub-signal of `alreadyConsumed`: the consumed
 *      message's turn already produced a terminal result, so the job was
 *      completed instead of re-driven (the "zombie turn" self-heal). A spike
 *      means stale-consumed turns whose queries leaked are being detected and
 *      freed — the deadlock this counter watches for would otherwise park every
 *      new message as a steer behind the held active-turn slot.
 *  (c) residual-window latency — time from the SDK-consume signal (onSent) to
 *      the persisted consumed-flip, P50/P99. This is the exposure surface for a
 *      crash-duplicate; item 12's synchronous flip keeps it sub-ms.
 *
 * In-memory + per-daemon (not persisted): operational telemetry, reset on
 * restart. Every structure is bounded so a long-running daemon does not grow it.
 */

import { createHash } from 'node:crypto';
import type { JobQueueProcessorSnapshot } from '../../storage/job-queue-processor';
import { emitStructuredLogEvent } from '../logger';

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
  } catch {
    // Observability must never alter delivery behavior.
  }
}

export type ReclaimSkipOutcome =
  | 'alreadyConsumed'
  | 'alreadySubmitted'
  | 'noContent'
  | 'turn_terminated';

export interface DeliveryMetricsSnapshot {
  /** Total SDK handoffs observed (plain counter, O(1) memory). */
  feedsObserved: number;
  /** UUIDs handed to the SDK more than once within the recent window — each is a real exactly-once breach. */
  duplicateFeedCount: number;
  /** The offending UUIDs (capped) for diagnosis. */
  duplicateUuids: string[];
  /** Claims that did NOT feed (reclaim-skipped or no-content) — duplicates prevented. */
  reclaimSkips: Record<ReclaimSkipOutcome, number>;
  /** Residual-window latency (SDK-consume → persisted consumed-flip), ms. */
  residualWindowP50: number | null;
  residualWindowP99: number | null;
  residualWindowSamples: number;
  /**
   * Cumulative `message_delivery` jobs that exhausted their retry budget and
   * dead-lettered (→ the persisted message flipped to `failed`). A sustained
   * rise is the retry-storm signal: a session or provider stuck in a recoverable
   * error loop, burning the full retry budget per message. Counted from the
   * lane's `onDead` hook — one increment per terminal `dead` job.
   */
  deadLetters: number;
}

/**
 * The `messageDelivery.diagnostics` RPC payload — a thin job_queue snapshot
 * paired with the exactly-once metrics. Named (not anonymous) so the contract
 * is explicit; lives in daemon (no web consumer yet — promote to `packages/
 * shared` if a client adopts it). (task #861, review P2.)
 */
export interface MessageDeliveryDiagnostics {
  lane: string;
  statusCounts: Record<string, number>;
  /** processing rows past the reclaimStale lease window (reclaimable). */
  staleProcessing: number;
  /** processing rows within the lease window (healthy in-flight turns). */
  activeProcessing: number;
  oldestProcessingLeaseAgeMs: number | null;
  processor: JobQueueProcessorSnapshot;
  metrics: DeliveryMetricsSnapshot;
}

const RESIDUAL_WINDOW_SAMPLE_CAP = 1000;
const DUPLICATE_UUID_CAP = 100;
/** Bounded LRU window of recently-fed UUIDs for duplicate detection. */
const RECENT_FEED_WINDOW = 1000;

/**
 * Per-daemon delivery metrics collector. A single instance is shared by the
 * handler + bridge; tests construct their own. Methods are safe to call from
 * concurrent ticks (coarse-grained telemetry, not transactional).
 */
export class DeliveryMetrics {
  private feedsObserved = 0;
  /** Insertion-ordered LRU: uuid → feed count (only within the recent window). */
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

  /**
   * Record one SDK handoff of `messageUuid`. Call from the bridge at the point
   * the message is actually fed (admitWithId admission). A second feed of the
   * same UUID within the recent window is a ground-truth duplicate.
   */
  recordFeed(messageUuid: string): void {
    this.feedsObserved++;
    const prior = this.recentFeeds.get(messageUuid) ?? 0;
    if (prior >= 1) {
      // A genuine re-feed of a UUID already seen in the window → record breach.
      if (!this.duplicateUuids.includes(messageUuid)) {
        this.duplicateUuids.push(messageUuid);
        if (this.duplicateUuids.length > DUPLICATE_UUID_CAP) this.duplicateUuids.shift();
      }
    }
    // (Re)insert to refresh LRU position; evict oldest when over cap.
    this.recentFeeds.delete(messageUuid);
    this.recentFeeds.set(messageUuid, prior + 1);
    if (this.recentFeeds.size > RECENT_FEED_WINDOW) {
      // Map iteration is insertion-ordered; drop the oldest entry.
      const oldest = this.recentFeeds.keys().next().value as string | undefined;
      if (oldest !== undefined) this.recentFeeds.delete(oldest);
    }
  }

  /**
   * Declare the prior feed of `messageUuid` void: its turn was confirmed to
   * have produced no result and the delivery bridge reopened the row, so the
   * NEXT feed of this UUID is an intentional recovery re-drive — not the
   * exactly-once breach `duplicateUuids` exists to flag. Drops the UUID from
   * the recent-feed window (a feed whose first attempt aged out needs no
   * forget; the next feed reads as first either way). `feedsObserved` still
   * counts every handoff — only duplicate attribution is reset. Call at the
   * reopen, before the retry can feed again. (Codex P2.)
   */
  forgetFeed(messageUuid: string): void {
    this.recentFeeds.delete(messageUuid);
  }

  /**
   * Record a claim that did NOT feed — a reclaim-skip (alreadyConsumed /
   * alreadySubmitted) or noContent. These are the duplicates-PREVENTED signal.
   * NOT called for the normal fresh-feed path (an `enqueued` row that feeds),
   * so the counters cannot be diluted by ordinary traffic.
   */
  recordReclaimSkip(outcome: ReclaimSkipOutcome): void {
    this.reclaimSkips[outcome]++;
  }

  /**
   * Record the residual-window latency (ms) — SDK-consume signal to persisted
   * consumed-flip (item 13c). Bounded ring; a throwaway probe does not skew it.
   * NOTE: this is a tight lower bound — the timestamp is captured when the
   * acknowledgment continuation resumes (within ~one microtask of onSent), so
   * it measures the synchronous db flip + any event-loop scheduling delay on
   * the resume, not the full [onSent, flip] wall clock. Sufficient to confirm
   * the window stays small.
   */
  recordResidualWindow(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.residualWindows.push(ms);
    if (this.residualWindows.length > RESIDUAL_WINDOW_SAMPLE_CAP) {
      this.residualWindows.shift();
    }
  }

  /**
   * Record a `message_delivery` job that dead-lettered (exhausted its retry
   * budget). Call from the lane's `onDead` hook. A sustained rise is the
   * retry-storm signal.
   */
  recordDeadLetter(): void {
    this.deadLetters++;
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
    };
  }
}

/** Percentile of a sample (linear interpolation between closest ranks). Null when empty. */
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

/**
 * The process-wide delivery metrics instance. Wired into the message-delivery
 * handler + bridge in app.ts; tests use their own `new DeliveryMetrics()`.
 */
export const deliveryMetrics = new DeliveryMetrics();
