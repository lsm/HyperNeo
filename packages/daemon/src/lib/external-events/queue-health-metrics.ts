/**
 * In-memory health metrics for the pending external-event delivery queue.
 *
 * Pending external-event delivery is the runtime's core reliability mechanism
 * for getting a GitHub (or other source) event to a workflow node agent that
 * is not yet ready to receive it. These counters + live gauges give operators
 * a single view of queue health: how much is being enqueued and from where,
 * which target states force queuing, how often deliveries are skipped
 * (claim conflicts, stale sessions, deliverability guards), how often the
 * queue evicts (cap/TTL), and the terminal outcome of every delivery.
 *
 * Cumulative counters are process-lifetime (since the runtime started) and are
 * NOT persisted — they reset on daemon restart. Live gauges (depth, age,
 * in-flight) are computed at read time by {@link SpaceRuntime.getQueueHealthSnapshot}
 * from the runtime's in-memory maps and the durable store, then merged with
 * these counters into a {@link QueueHealthSnapshot}.
 */

/**
 * A delivery row that just transitioned to a terminal state. Emitted by
 * `ExternalEventStore` via its delivery-terminal hook — the single source of
 * truth for `delivered` and `finalFailuresByReason`, so every terminal
 * transition is counted exactly once regardless of which call path reached it.
 */
export interface DeliveryTerminalEvent {
  eventId: string;
  deliveryKey: string;
  /** `delivered` for success, `failed` for a terminal failure. */
  outcome: 'delivered' | 'failed';
  /** Free-form failure reason (`null` when delivered). */
  reason: string | null;
}

/** Min/max/avg/p95 of a set of millisecond ages (event-age of queued items). */
export interface QueueAgeStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
}

/** Cumulative counters since the runtime started counting. */
export interface QueueHealthCounters {
  /** Epoch ms when counting started (runtime start). */
  since: number;
  /** Total items enqueued into the in-memory pending queue. */
  enqueue: number;
  /** Enqueues broken down by event source (e.g. `github`). */
  enqueueBySource: Record<string, number>;
  /**
   * Enqueues broken down by the target's run+node state at enqueue time
   * (e.g. `run=in_progress;node=pending`). Surfaces which states force
   * events to be queued rather than delivered immediately.
   */
  enqueueByTargetState: Record<string, number>;
  /** Number of pending-queue flush attempts (target activation / retry). */
  flushAttempts: number;
  /** Total items handed off to dispatch across all flush attempts. */
  flushItemsDispatched: number;
  /** Deliveries that reached terminal `delivered` (success). */
  delivered: number;
  /**
   * Terminal failures broken down by persisted `failure_reason`. Bounded to
   * {@link MAX_FAILURE_REASON_KEYS} distinct reasons; reasons beyond the cap
   * fold into a single `__other__` bucket so per-session dynamic reasons can't
   * grow this map (and the snapshot payload) without bound. The sum always
   * equals the total terminal-failure count.
   */
  finalFailuresByReason: Record<string, number>;
  /**
   * Non-terminal skips: a delivery was ready to dispatch but another path
   * already had it in flight (`externalEventDeliveriesInFlight`). The delivery
   * stays pending; this counts how often concurrent dispatch races occurred.
   */
  claimConflicts: number;
  /**
   * Non-terminal skips: the target's worker session was no longer live at
   * injection time, so the delivery was deferred/requeued rather than
   * injected. A session-loss signal (worker crashed or was superseded).
   */
  staleSessionSkips: number;
  /**
   * Non-terminal skips: a delivery was deferred because the target's space was
   * paused/stopped at injection time. Distinct from `staleSessionSkips` (a
   * reliability signal) since pausing a space is intentional — the delivery
   * stays pending and is requeued by `onSpaceResumed`.
   */
  pausedSpaceSkips: number;
  /**
   * Non-terminal skips: a delivery was skipped because its target is within the
   * recoverable-failure cool-down window (its last dispatch threw
   * non-terminally). The event stays `published` and re-evaluates once the
   * window lifts, so a session stuck in a provider-error loop does not mint a
   * fresh `failed` row on every re-poll. A sustained high rate is the
   * external-event delivery storm signal.
   */
  cooldownSkips: number;
}

/** Live gauges computed at read time from in-memory + DB state. */
export interface QueueHealthGauges {
  /** In-memory pending items across all target queues. */
  queueDepth: number;
  /** Distinct target queues currently holding pending items. */
  queueKeys: number;
  /** Delivery keys currently mid-dispatch (`externalEventDeliveriesInFlight`). */
  inFlight: number;
  /** Items buffered in rate-limit digests awaiting the next digest flush. */
  digestBacklog: number;
  /** Active bounded retry timers. */
  retryTimers: number;
  /** DB-persisted `pending` delivery rows (global, across all runs). */
  persistedPending: number;
  /** Event-age stats for in-memory queued items, or `null` when empty. */
  queueAgeMs: QueueAgeStats | null;
  /** Event-age stats for DB-persisted pending deliveries, or `null` when none. */
  persistedAgeMs: QueueAgeStats | null;
}

/** Aggregate queue-health snapshot surfaced to operators/debug views. */
export interface QueueHealthSnapshot {
  /** Epoch ms the snapshot was collected. */
  collectedAt: number;
  counters: QueueHealthCounters;
  /**
   * Terminal failures grouped into operator-meaningful categories, tracked
   * directly (not derived from `finalFailuresByReason`) so the totals stay
   * exact even when the raw-reason map is capped. Each terminal failure is
   * counted in exactly one category.
   */
  failuresByCategory: Record<FailureCategory, number>;
  gauges: QueueHealthGauges;
}

export type FailureCategory =
  | 'ttl_expired'
  | 'cap_eviction'
  | 'deliverability'
  | 'retry_exhausted'
  | 'injection_error'
  | 'other';

const FAILURE_CATEGORY_PREFIXES: Array<{
  category: FailureCategory;
  test: (reason: string) => boolean;
}> = [
  { category: 'ttl_expired', test: (r) => r === 'ttl_expired' },
  { category: 'cap_eviction', test: (r) => r === 'pending_node_queue_overflow' },
  // Deliverability: the target/run is no longer a valid delivery destination
  // (run not deliverable, task terminal, subscription removed/cleared, node
  // cancelled, or queued deliveries swept during run-interests rebuild /
  // terminal cleanup). These are all terminal `markDeliveryFailed` reasons
  // that reach the delivery-terminal hook.
  // NOTE: `blocked_run_gate_not_opened` is intentionally absent — it is set via
  // event-level `markEventFailed`, which never fires the delivery hook, so it
  // can never appear in `finalFailuresByReason`.
  {
    category: 'deliverability',
    test: (r) =>
      r === 'run_not_externally_deliverable' ||
      r === 'target_task_terminal' ||
      r === 'target_task_reactivation_failed' ||
      r === 'subscription_no_longer_active' ||
      r === 'invalid_target_ownership' ||
      r === 'node_execution_cancelled' ||
      r === 'run_interests_rebuilt' ||
      r === 'run_terminal_cleanup' ||
      r === 'task_terminal_cleanup',
  },
  // Retry-exhaustion terminal failures carry the underlying activation/delivery
  // reason (e.g. `node_execution_not_active`, `activation_failed; ...`). The
  // long-horizon delivery path throws its own deterministic unavailability
  // reasons that also surface on retry exhaustion.
  {
    category: 'retry_exhausted',
    test: (r) =>
      r === 'node_execution_not_active' ||
      r === 'node_execution_pending' ||
      r === 'long-horizon agent unavailable' ||
      r === 'long-horizon event delivery unavailable' ||
      r.startsWith('activation_failed') ||
      r.startsWith('retry_exhausted;'),
  },
  // Injection errors surface as a `deliveryMode:<mode>; <error>` reason.
  {
    category: 'injection_error',
    test: (r) => r.startsWith('deliveryMode:'),
  },
];

/**
 * Map a persisted terminal failure reason to an operator category. Reasons that
 * do not match a known prefix fall back to `other`.
 *
 * SpaceRuntime prefixes parked/deferred delivery reasons with
 * `deliveryMode:<mode>; ` — strip it before category matching so e.g.
 * `deliveryMode:defer; node_execution_not_active` still categorizes as
 * retry-exhaustion rather than falling through to injection_error.
 */
export function categorizeFailureReason(reason: string): FailureCategory {
  // Prefer the stripped payload (so defer-prefixed activation reasons keep
  // their retry-exhaustion category); fall back to the raw reason so a
  // genuine injection failure (`deliveryMode:<mode>; <inject error>`) still
  // matches the deliveryMode: prefix rule.
  const stripped = reason.replace(/^deliveryMode:[^;]*;\s*/, '');
  for (const { category, test } of FAILURE_CATEGORY_PREFIXES) {
    if (test(stripped)) return category;
  }
  for (const { category, test } of FAILURE_CATEGORY_PREFIXES) {
    if (test(reason)) return category;
  }
  return 'other';
}

const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'ttl_expired',
  'cap_eviction',
  'deliverability',
  'retry_exhausted',
  'injection_error',
  'other',
];

/**
 * Cap on the number of distinct raw failure-reason keys retained for
 * diagnostics. Terminal failure reasons can carry dynamic per-session data
 * (e.g. `deliveryMode:immediate; Sub-session not found: <uuid>`), so without a
 * cap this map — and every snapshot that serializes it — would grow without
 * bound over the process lifetime. Category totals are tracked separately and
 * remain exact regardless of this cap.
 */
const MAX_FAILURE_REASON_KEYS = 64;

/**
 * Bucket that accumulates terminal failures whose distinct reason exceeded the
 * retained-key cap. Keeps the raw-reason map bounded while preserving a correct
 * total (the sum of `finalFailuresByReason` always equals total terminal failures).
 */
const FAILURE_REASON_OVERFLOW_KEY = '__other__';

function computeAgeStats(ages: readonly number[]): QueueAgeStats | null {
  if (ages.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const age of ages) {
    if (age < min) min = age;
    if (age > max) max = age;
    sum += age;
  }
  const sorted = [...ages].sort((a, b) => a - b);
  // Nearest-rank p95 (no interpolation): the ceil(0.95 * n)th value, clamped.
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: ages.length,
    minMs: min,
    maxMs: max,
    avgMs: Math.round(sum / ages.length),
    p95Ms: sorted[p95Index]!,
  };
}

/**
 * Lightweight in-memory counter store for pending external-event queue health.
 *
 * Not thread-safe in any concurrent sense — it relies on the single-threaded
 * event loop of {@link SpaceRuntime}, which owns all queue mutations.
 */
export class ExternalEventQueueMetrics {
  private readonly since: number;
  private enqueue = 0;
  private readonly enqueueBySource = new Map<string, number>();
  private readonly enqueueByTargetState = new Map<string, number>();
  private flushAttempts = 0;
  private flushItemsDispatched = 0;
  private delivered = 0;
  private readonly finalFailuresByReason = new Map<string, number>();
  /**
   * Category totals tracked directly (not derived from `finalFailuresByReason`)
   * so they stay exact even when the raw-reason map is capped.
   */
  private readonly failuresByCategoryCount = new Map<FailureCategory, number>();
  private claimConflicts = 0;
  private staleSessionSkips = 0;
  private pausedSpaceSkips = 0;
  private cooldownSkips = 0;

  constructor(now: number = Date.now()) {
    this.since = now;
  }

  /** Record an enqueue into the pending queue, attributed to a source + target state. */
  recordEnqueue(source: string, targetState: string): void {
    this.enqueue += 1;
    this.enqueueBySource.set(source, (this.enqueueBySource.get(source) ?? 0) + 1);
    this.enqueueByTargetState.set(
      targetState,
      (this.enqueueByTargetState.get(targetState) ?? 0) + 1
    );
  }

  /** Record a flush attempt and how many items it handed off to dispatch. */
  recordFlushAttempt(itemsDispatched: number): void {
    this.flushAttempts += 1;
    this.flushItemsDispatched += itemsDispatched;
  }

  /** Record a non-terminal skip caused by the delivery already being in flight. */
  recordClaimConflict(): void {
    this.claimConflicts += 1;
  }

  /** Record a non-terminal skip caused by the target session not being live. */
  recordStaleSessionSkip(): void {
    this.staleSessionSkips += 1;
  }

  /** Record a non-terminal skip caused by the target's space being paused/stopped. */
  recordPausedSpaceSkip(): void {
    this.pausedSpaceSkips += 1;
  }

  /**
   * Record a non-terminal skip caused by the target being within its
   * recoverable-failure cool-down window (last dispatch threw non-terminally).
   */
  recordCooldownSkip(): void {
    this.cooldownSkips += 1;
  }

  /**
   * Record a delivery terminal transition. Called from the store's
   * delivery-terminal hook — the single point that observes every `delivered`
   * and terminal `failed` transition.
   */
  recordDeliveryTerminal(event: DeliveryTerminalEvent): void {
    if (event.outcome === 'delivered') {
      this.delivered += 1;
      return;
    }
    const reason = event.reason ?? 'unknown';
    // Track the category directly so it stays exact even when the raw-reason
    // map is capped below.
    const category = categorizeFailureReason(reason);
    this.failuresByCategoryCount.set(
      category,
      (this.failuresByCategoryCount.get(category) ?? 0) + 1
    );
    // Bound raw-reason cardinality: an existing reason keeps incrementing; a
    // new reason is added only while under the cap, otherwise it folds into the
    // single overflow bucket. Keeps the map + snapshot payload bounded while
    // preserving a correct total.
    if (
      this.finalFailuresByReason.has(reason) ||
      this.finalFailuresByReason.size < MAX_FAILURE_REASON_KEYS
    ) {
      this.finalFailuresByReason.set(reason, (this.finalFailuresByReason.get(reason) ?? 0) + 1);
    } else {
      this.finalFailuresByReason.set(
        FAILURE_REASON_OVERFLOW_KEY,
        (this.finalFailuresByReason.get(FAILURE_REASON_OVERFLOW_KEY) ?? 0) + 1
      );
    }
  }

  /** Read-only copy of the cumulative counters. */
  getCounters(): QueueHealthCounters {
    return {
      since: this.since,
      enqueue: this.enqueue,
      enqueueBySource: recordToObject(this.enqueueBySource),
      enqueueByTargetState: recordToObject(this.enqueueByTargetState),
      flushAttempts: this.flushAttempts,
      flushItemsDispatched: this.flushItemsDispatched,
      delivered: this.delivered,
      finalFailuresByReason: recordToObject(this.finalFailuresByReason),
      claimConflicts: this.claimConflicts,
      staleSessionSkips: this.staleSessionSkips,
      pausedSpaceSkips: this.pausedSpaceSkips,
      cooldownSkips: this.cooldownSkips,
    };
  }

  /**
   * Build the operator snapshot by merging the cumulative counters with
   * live gauges (computed by the caller from in-memory + DB state).
   */
  snapshot(gauges: QueueHealthGauges, now: number = Date.now()): QueueHealthSnapshot {
    const counters = this.getCounters();
    const failuresByCategory = {} as Record<FailureCategory, number>;
    for (const category of FAILURE_CATEGORIES) {
      failuresByCategory[category] = this.failuresByCategoryCount.get(category) ?? 0;
    }
    return { collectedAt: now, counters, failuresByCategory, gauges };
  }
}

/** Exposed for age-stat computation in {@link SpaceRuntime.getQueueHealthSnapshot}. */
export { computeAgeStats as computeQueueAgeStats };

function recordToObject(map: Map<string, number>): Record<string, number> {
  // Null-prototype object so a key like `__proto__` (which exceptions can
  // persist verbatim as a terminal failure reason) becomes a normal own
  // property instead of hitting Object.prototype's `__proto__` setter —
  // which would otherwise silently drop the entry and pollute the prototype.
  const obj: Record<string, number> = Object.create(null);
  for (const [key, value] of map) obj[key] = value;
  return obj;
}
