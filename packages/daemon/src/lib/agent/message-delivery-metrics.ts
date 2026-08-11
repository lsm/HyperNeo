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
 * Three signals:
 *  (a) feed-count-per-UUID — instrument the actual SDK handoff (driveDeliveryTurn
 *      / feedDeliverySteer) with the message UUID. Any UUID handed off >1 time is
 *      a GROUND-TRUTH duplicate (the SDK does not dedup). This is the authoritative
 *      exactly-once breach detector.
 *  (b) reclaim-outcome breakdown — of all reclaimStale re-drives, count
 *      {alreadyConsumed→skip, alreadySubmitted→skip, stillEnqueued→re-drive,
 *      noContent}. `alreadyConsumed` skips are duplicates PREVENTED (leading
 *      indicator; a spike means crashes-during-turn are rising).
 *  (c) residual-window latency — time from the SDK-consume signal (onSent) to the
 *      persisted consumed-flip, P50/P99. This is the exposure surface for a
 *      crash-duplicate; item 12's synchronous flip keeps it sub-ms.
 *
 * In-memory + per-daemon (not persisted): these are operational telemetry, reset
 * on restart. Kept small (bounded sample window) so a long-running daemon does
 * not grow it unbounded.
 */

export type ReclaimOutcome = 'alreadyConsumed' | 'alreadySubmitted' | 'stillEnqueued' | 'noContent';

export interface DeliveryMetricsSnapshot {
  /** UUIDs handed to the SDK more than once — each is a real exactly-once breach. */
  duplicateFeedCount: number;
  /** The offending UUIDs (capped) for diagnosis. */
  duplicateUuids: string[];
  /** Total distinct UUIDs ever handed off. */
  feedsObserved: number;
  /** Reclaim outcomes — `alreadyConsumed`/`alreadySubmitted` are duplicates prevented. */
  reclaimOutcomes: Record<ReclaimOutcome, number>;
  /** Residual-window latency (SDK-consume → persisted consumed-flip), ms. */
  residualWindowP50: number | null;
  residualWindowP99: number | null;
  residualWindowSamples: number;
}

const RESIDUAL_WINDOW_SAMPLE_CAP = 1000;
const DUPLICATE_UUID_CAP = 100;

/**
 * Per-daemon delivery metrics collector. A single instance is shared by the
 * handler + bridge; tests construct their own. Methods are idempotent and
 * safe to call from concurrent ticks (the counters are coarse-grained telemetry,
 * not transactional).
 */
export class DeliveryMetrics {
  private feedCounts = new Map<string, number>();
  private duplicateUuids: string[] = [];
  private reclaimOutcomes: Record<ReclaimOutcome, number> = {
    alreadyConsumed: 0,
    alreadySubmitted: 0,
    stillEnqueued: 0,
    noContent: 0,
  };
  private residualWindows: number[] = [];

  /**
   * Record one SDK handoff of `messageUuid`. Call from the bridge at the point
   * the message is actually fed (admitWithId admission), keyed by the UUID — the
   * ground-truth duplicate detector. A reclaim re-feed of a not-yet-consumed
   * message increments the same UUID's count and flags the duplicate.
   */
  recordFeed(messageUuid: string): void {
    const next = (this.feedCounts.get(messageUuid) ?? 0) + 1;
    this.feedCounts.set(messageUuid, next);
    if (next === 2 && !this.duplicateUuids.includes(messageUuid)) {
      this.duplicateUuids.push(messageUuid);
      if (this.duplicateUuids.length > DUPLICATE_UUID_CAP) this.duplicateUuids.shift();
    }
  }

  /** Record the outcome of one reclaimStale re-drive (item 13b). */
  recordReclaimOutcome(outcome: ReclaimOutcome): void {
    this.reclaimOutcomes[outcome]++;
  }

  /**
   * Record the residual-window latency (ms) — SDK-consume signal to persisted
   * consumed-flip (item 13c). Bounded ring; a throwaway probe does not skew it.
   */
  recordResidualWindow(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.residualWindows.push(ms);
    if (this.residualWindows.length > RESIDUAL_WINDOW_SAMPLE_CAP) {
      this.residualWindows.shift();
    }
  }

  snapshot(): DeliveryMetricsSnapshot {
    return {
      duplicateFeedCount: this.duplicateUuids.length,
      duplicateUuids: [...this.duplicateUuids],
      feedsObserved: this.feedCounts.size,
      reclaimOutcomes: { ...this.reclaimOutcomes },
      residualWindowP50: percentile(this.residualWindows, 0.5),
      residualWindowP99: percentile(this.residualWindows, 0.99),
      residualWindowSamples: this.residualWindows.length,
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
