export interface DeliveryTerminalEvent {
  eventId: string;
  deliveryKey: string;
  outcome: 'delivered' | 'failed';
  reason: string | null;
}

export interface QueueAgeStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
}

export interface QueueHealthCounters {
  since: number;
  enqueue: number;
  enqueueBySource: Record<string, number>;
  enqueueByTargetState: Record<string, number>;
  flushAttempts: number;
  flushItemsDispatched: number;
  delivered: number;
  finalFailuresByReason: Record<string, number>;
  claimConflicts: number;
  staleSessionSkips: number;
  pausedSpaceSkips: number;
  cooldownSkips: number;
  directSteerEnqueued: number;
  directSteerSuppressedByBufferCap: number;
  directSteerEnqueuedByClass: Record<string, number>;
}

export interface QueueHealthGauges {
  queueDepth: number;
  queueKeys: number;
  inFlight: number;
  digestBacklog: number;
  retryTimers: number;
  persistedPending: number;
  queueAgeMs: QueueAgeStats | null;
  persistedAgeMs: QueueAgeStats | null;
}

export interface QueueHealthSnapshot {
  collectedAt: number;
  counters: QueueHealthCounters;
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
  {
    category: 'injection_error',
    test: (r) => r.startsWith('deliveryMode:'),
  },
];

export function categorizeFailureReason(reason: string): FailureCategory {
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

const MAX_FAILURE_REASON_KEYS = 64;

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
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    count: ages.length,
    minMs: min,
    maxMs: max,
    avgMs: Math.round(sum / ages.length),
    p95Ms: sorted[p95Index]!,
  };
}

export class ExternalEventQueueMetrics {
  private readonly since: number;
  private enqueue = 0;
  private readonly enqueueBySource = new Map<string, number>();
  private readonly enqueueByTargetState = new Map<string, number>();
  private flushAttempts = 0;
  private flushItemsDispatched = 0;
  private delivered = 0;
  private readonly finalFailuresByReason = new Map<string, number>();
  private readonly failuresByCategoryCount = new Map<FailureCategory, number>();
  private claimConflicts = 0;
  private staleSessionSkips = 0;
  private pausedSpaceSkips = 0;
  private cooldownSkips = 0;
  private directSteerEnqueued = 0;
  private directSteerSuppressedByBufferCap = 0;
  private readonly directSteerEnqueuedByClass = new Map<string, number>();

  constructor(now: number = Date.now()) {
    this.since = now;
  }

  recordEnqueue(source: string, targetState: string): void {
    this.enqueue += 1;
    this.enqueueBySource.set(source, (this.enqueueBySource.get(source) ?? 0) + 1);
    this.enqueueByTargetState.set(
      targetState,
      (this.enqueueByTargetState.get(targetState) ?? 0) + 1
    );
  }

  recordFlushAttempt(itemsDispatched: number): void {
    this.flushAttempts += 1;
    this.flushItemsDispatched += itemsDispatched;
  }

  recordClaimConflict(): void {
    this.claimConflicts += 1;
  }

  recordStaleSessionSkip(): void {
    this.staleSessionSkips += 1;
  }

  recordPausedSpaceSkip(): void {
    this.pausedSpaceSkips += 1;
  }

  recordCooldownSkip(): void {
    this.cooldownSkips += 1;
  }

  recordDirectSteerEnqueued(): void {
    this.directSteerEnqueued += 1;
  }

  recordDirectSteerEnqueuedClass(eventClass: string): void {
    this.directSteerEnqueuedByClass.set(
      eventClass,
      (this.directSteerEnqueuedByClass.get(eventClass) ?? 0) + 1
    );
  }

  recordDirectSteerSuppressedByBufferCap(): void {
    this.directSteerSuppressedByBufferCap += 1;
  }

  recordDeliveryTerminal(event: DeliveryTerminalEvent): void {
    if (event.outcome === 'delivered') {
      this.delivered += 1;
      return;
    }
    const reason = event.reason ?? 'unknown';
    const category = categorizeFailureReason(reason);
    this.failuresByCategoryCount.set(
      category,
      (this.failuresByCategoryCount.get(category) ?? 0) + 1
    );
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
      directSteerEnqueued: this.directSteerEnqueued,
      directSteerSuppressedByBufferCap: this.directSteerSuppressedByBufferCap,
      directSteerEnqueuedByClass: recordToObject(this.directSteerEnqueuedByClass),
    };
  }

  snapshot(gauges: QueueHealthGauges, now: number = Date.now()): QueueHealthSnapshot {
    const counters = this.getCounters();
    const failuresByCategory = {} as Record<FailureCategory, number>;
    for (const category of FAILURE_CATEGORIES) {
      failuresByCategory[category] = this.failuresByCategoryCount.get(category) ?? 0;
    }
    return { collectedAt: now, counters, failuresByCategory, gauges };
  }
}

export { computeAgeStats as computeQueueAgeStats };

function recordToObject(map: Map<string, number>): Record<string, number> {
  const obj: Record<string, number> = Object.create(null);
  for (const [key, value] of map) obj[key] = value;
  return obj;
}
