/**
 * ExternalEventQueueMetrics unit tests.
 *
 * Pure in-memory counter behavior — no DB. Covers enqueue attribution, flush,
 * skip counters, terminal-outcome recording, and failure categorization in the
 * snapshot.
 */

import { describe, expect, test } from 'bun:test';
import {
  ExternalEventQueueMetrics,
  categorizeFailureReason,
  computeQueueAgeStats,
  type QueueHealthGauges,
} from '../../../../src/lib/external-events/queue-health-metrics';

const EMPTY_GAUGES: QueueHealthGauges = {
  queueDepth: 0,
  queueKeys: 0,
  inFlight: 0,
  digestBacklog: 0,
  retryTimers: 0,
  persistedPending: 0,
  queueAgeMs: null,
  persistedAgeMs: null,
};

describe('ExternalEventQueueMetrics — enqueue attribution', () => {
  test('counts total enqueues and breaks them down by source + target state', () => {
    const metrics = new ExternalEventQueueMetrics(1000);
    metrics.recordEnqueue('github', 'run=in_progress;node=pending');
    metrics.recordEnqueue('github', 'run=in_progress;node=pending');
    metrics.recordEnqueue('slack', 'run=blocked;node=in_progress');

    const counters = metrics.getCounters();
    expect(counters.enqueue).toBe(3);
    expect(counters.enqueueBySource).toEqual({ github: 2, slack: 1 });
    expect(counters.enqueueByTargetState).toEqual({
      'run=in_progress;node=pending': 2,
      'run=blocked;node=in_progress': 1,
    });
  });
});

describe('ExternalEventQueueMetrics — flush + skip counters', () => {
  test('accumulates flush attempts and dispatched items', () => {
    const metrics = new ExternalEventQueueMetrics(1000);
    metrics.recordFlushAttempt(3);
    metrics.recordFlushAttempt(0);
    metrics.recordFlushAttempt(2);

    const counters = metrics.getCounters();
    expect(counters.flushAttempts).toBe(3);
    expect(counters.flushItemsDispatched).toBe(5);
  });

  test('counts claim conflicts, stale-session skips, and paused-space skips separately', () => {
    const metrics = new ExternalEventQueueMetrics(1000);
    metrics.recordClaimConflict();
    metrics.recordClaimConflict();
    metrics.recordStaleSessionSkip();
    metrics.recordPausedSpaceSkip();
    metrics.recordPausedSpaceSkip();
    metrics.recordPausedSpaceSkip();

    const counters = metrics.getCounters();
    expect(counters.claimConflicts).toBe(2);
    expect(counters.staleSessionSkips).toBe(1);
    expect(counters.pausedSpaceSkips).toBe(3);
  });
});

describe('ExternalEventQueueMetrics — terminal outcomes', () => {
  test('counts delivered and terminal failures by reason', () => {
    const metrics = new ExternalEventQueueMetrics(1000);
    metrics.recordDeliveryTerminal({
      eventId: 'e1',
      deliveryKey: 'd1',
      outcome: 'delivered',
      reason: null,
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e2',
      deliveryKey: 'd2',
      outcome: 'delivered',
      reason: null,
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e3',
      deliveryKey: 'd3',
      outcome: 'failed',
      reason: 'ttl_expired',
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e4',
      deliveryKey: 'd4',
      outcome: 'failed',
      reason: 'run_not_externally_deliverable',
    });

    const counters = metrics.getCounters();
    expect(counters.delivered).toBe(2);
    expect(counters.finalFailuresByReason).toEqual({
      ttl_expired: 1,
      run_not_externally_deliverable: 1,
    });
  });
});

describe('ExternalEventQueueMetrics — snapshot', () => {
  test('merges counters with gauges and categorizes failures', () => {
    const metrics = new ExternalEventQueueMetrics(1000);
    metrics.recordEnqueue('github', 'run=in_progress;node=pending');
    metrics.recordDeliveryTerminal({
      eventId: 'e1',
      deliveryKey: 'd1',
      outcome: 'delivered',
      reason: null,
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e2',
      deliveryKey: 'd2',
      outcome: 'failed',
      reason: 'pending_node_queue_overflow',
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e3',
      deliveryKey: 'd3',
      outcome: 'failed',
      reason: 'subscription_no_longer_active',
    });
    metrics.recordDeliveryTerminal({
      eventId: 'e4',
      deliveryKey: 'd4',
      outcome: 'failed',
      reason: 'deliveryMode:immediate; boom',
    });

    const snapshot = metrics.snapshot({ ...EMPTY_GAUGES, queueDepth: 4, inFlight: 1 }, 5000);

    expect(snapshot.collectedAt).toBe(5000);
    expect(snapshot.counters.since).toBe(1000);
    expect(snapshot.counters.enqueue).toBe(1);
    expect(snapshot.counters.delivered).toBe(1);
    expect(snapshot.gauges.queueDepth).toBe(4);
    expect(snapshot.gauges.inFlight).toBe(1);
    // Each terminal failure lands in exactly one category.
    expect(snapshot.failuresByCategory).toEqual({
      ttl_expired: 0,
      cap_eviction: 1,
      deliverability: 1,
      retry_exhausted: 0,
      injection_error: 1,
      other: 0,
    });
  });
});

describe('categorizeFailureReason', () => {
  test.each([
    ['ttl_expired', 'ttl_expired'],
    ['pending_node_queue_overflow', 'cap_eviction'],
    ['run_not_externally_deliverable', 'deliverability'],
    ['target_task_terminal', 'deliverability'],
    ['subscription_no_longer_active', 'deliverability'],
    ['auto_pr_subscription_cleared', 'deliverability'],
    ['node_execution_cancelled', 'deliverability'],
    ['run_interests_rebuilt', 'deliverability'],
    ['run_terminal_cleanup', 'deliverability'],
    ['node_execution_not_active', 'retry_exhausted'],
    ['node_execution_pending', 'retry_exhausted'],
    ['activation_failed; timeout', 'retry_exhausted'],
    ['deliveryMode:immediate; inject failed', 'injection_error'],
    // blocked_run_gate_not_opened is event-level (markEventFailed) and never
    // reaches the delivery hook, so it cannot appear in finalFailuresByReason;
    // if it ever did, it would fall through to `other`.
    ['blocked_run_gate_not_opened', 'other'],
    ['something_unexpected', 'other'],
  ])('categorizes %s -> %s', (reason, expected) => {
    expect(categorizeFailureReason(reason)).toBe(expected);
  });
});

describe('computeQueueAgeStats', () => {
  test('returns null for an empty set', () => {
    expect(computeQueueAgeStats([])).toBeNull();
  });

  test('computes min/max/avg/p95 for a small set', () => {
    const stats = computeQueueAgeStats([100, 200, 300, 400, 500]);
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(5);
    expect(stats!.minMs).toBe(100);
    expect(stats!.maxMs).toBe(500);
    expect(stats!.avgMs).toBe(300);
    // p95 nearest-rank of 5 values -> ceil(0.95*5)-1 = 4th index (500).
    expect(stats!.p95Ms).toBe(500);
  });
});
