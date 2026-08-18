import { describe, expect, it, beforeEach } from 'bun:test';
import {
  DeliveryMetrics,
  emitMessageDeliveryLifecycleEvent,
  fingerprintDeliveryClaim,
} from '../../../../src/lib/agent/message-delivery-metrics';
import {
  clearStructuredLogSubscribers,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';

describe('message delivery lifecycle events', () => {
  it('correlates claims without exposing the full token or payload content', () => {
    const token = 'secret-claim-token-value';
    const events: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    const unsubscribe = subscribeToStructuredLogs((event) => events.push(event));
    try {
      const claimFingerprint = fingerprintDeliveryClaim(token);
      expect(claimFingerprint).toHaveLength(16);
      expect(claimFingerprint).not.toContain(token);
      emitMessageDeliveryLifecycleEvent('claim', {
        jobId: 'job-1',
        claimFingerprint,
        sessionId: 'session-1',
        messageUuid: 'message-1',
      });
    } finally {
      unsubscribe();
      clearStructuredLogSubscribers();
    }

    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('message_delivery.lifecycle');
    expect(events[0].metadata).toMatchObject({
      event: 'claim',
      jobId: 'job-1',
      claimFingerprint: fingerprintDeliveryClaim(token),
    });
    expect(JSON.stringify(events[0])).not.toContain(token);
  });
});

describe('DeliveryMetrics (task #861 item 13)', () => {
  let metrics: DeliveryMetrics;

  beforeEach(() => {
    metrics = new DeliveryMetrics();
  });

  describe('feed-count-per-UUID (ground-truth duplicate detector)', () => {
    it('counts every SDK handoff in feedsObserved (plain counter)', () => {
      metrics.recordFeed('a');
      metrics.recordFeed('b');
      metrics.recordFeed('a');
      const snap = metrics.snapshot();
      expect(snap.feedsObserved).toBe(3);
    });

    it('flags a UUID fed more than once within the window as a real breach', () => {
      metrics.recordFeed('dup');
      metrics.recordFeed('dup');
      metrics.recordFeed('solo');
      const snap = metrics.snapshot();
      expect(snap.duplicateFeedCount).toBe(1);
      expect(snap.duplicateUuids).toContain('dup');
    });

    it('does not flag a UUID fed once', () => {
      metrics.recordFeed('once');
      expect(metrics.snapshot().duplicateFeedCount).toBe(0);
    });

    it('does not double-count a UUID fed 3+ times in duplicateUuids', () => {
      metrics.recordFeed('x');
      metrics.recordFeed('x');
      metrics.recordFeed('x');
      const snap = metrics.snapshot();
      expect(snap.duplicateFeedCount).toBe(1);
      expect(snap.feedsObserved).toBe(3);
    });

    it('forgetFeed exempts an intentional recovery re-drive from duplicate attribution', () => {
      metrics.recordFeed('recover');
      metrics.forgetFeed('recover');
      metrics.recordFeed('recover');
      const snap = metrics.snapshot();
      expect(snap.duplicateFeedCount).toBe(0);
      expect(snap.duplicateUuids).not.toContain('recover');
      expect(snap.feedsObserved).toBe(2);
    });

    it('forgetFeed does not un-flag an already-recorded true duplicate', () => {
      metrics.recordFeed('dup');
      metrics.recordFeed('dup');
      metrics.forgetFeed('dup');
      const snap = metrics.snapshot();
      expect(snap.duplicateFeedCount).toBe(1);
    });
  });

  describe('reclaim-skip outcomes (duplicates prevented)', () => {
    it('counts each skip outcome independently', () => {
      metrics.recordReclaimSkip('alreadyConsumed');
      metrics.recordReclaimSkip('alreadyConsumed');
      metrics.recordReclaimSkip('alreadySubmitted');
      metrics.recordReclaimSkip('noContent');
      const { reclaimSkips } = metrics.snapshot();
      expect(reclaimSkips).toEqual({
        alreadyConsumed: 2,
        alreadySubmitted: 1,
        noContent: 1,
        turn_terminated: 0,
      });
    });

    it('turn_terminated counts a consumed turn whose turn already ended (zombie self-heal)', () => {
      metrics.recordReclaimSkip('turn_terminated');
      metrics.recordReclaimSkip('turn_terminated');
      const { reclaimSkips } = metrics.snapshot();
      expect(reclaimSkips.turn_terminated).toBe(2);
    });

    it('alreadyConsumed + alreadySubmitted are the duplicates-prevented leading indicator', () => {
      metrics.recordReclaimSkip('alreadyConsumed');
      metrics.recordReclaimSkip('alreadySubmitted');
      const { reclaimSkips } = metrics.snapshot();
      expect(reclaimSkips.alreadyConsumed + reclaimSkips.alreadySubmitted).toBeGreaterThan(0);
    });
  });

  describe('residual-window latency (exposure surface)', () => {
    it('reports null percentiles before any sample', () => {
      const snap = metrics.snapshot();
      expect(snap.residualWindowP50).toBeNull();
      expect(snap.residualWindowP99).toBeNull();
      expect(snap.residualWindowSamples).toBe(0);
    });

    it('computes P50/P99 over recorded samples', () => {
      for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) metrics.recordResidualWindow(ms);
      const snap = metrics.snapshot();
      expect(snap.residualWindowSamples).toBe(10);
      expect(snap.residualWindowP50).toBeCloseTo(5.5, 5);
      expect(snap.residualWindowP99).toBeCloseTo(9.91, 2);
    });

    it('ignores non-finite / negative samples', () => {
      metrics.recordResidualWindow(2);
      metrics.recordResidualWindow(NaN);
      metrics.recordResidualWindow(-1);
      metrics.recordResidualWindow(Infinity);
      expect(metrics.snapshot().residualWindowSamples).toBe(1);
    });

    it('caps the sample window (bounded memory over a long-running daemon)', () => {
      for (let i = 0; i < 5000; i++) metrics.recordResidualWindow(i);
      expect(metrics.snapshot().residualWindowSamples).toBeLessThanOrEqual(1000);
    });
  });

  describe('dead-letter counter (retry-storm signal)', () => {
    it('counts dead-lettered deliveries cumulatively in the snapshot', () => {
      expect(metrics.snapshot().deadLetters).toBe(0);
      metrics.recordDeadLetter();
      metrics.recordDeadLetter();
      expect(metrics.snapshot().deadLetters).toBe(2);
    });
  });

  describe('bounded memory (review: bound the per-message feed history)', () => {
    it('caps the recent-feed window so memory does not grow with total message volume', () => {
      for (let i = 0; i < 10_000; i++) metrics.recordFeed(`uuid-${i}`);
      const snap = metrics.snapshot();
      expect(snap.feedsObserved).toBe(10_000);
      expect(snap.duplicateFeedCount).toBe(0);
    });

    it('still detects a duplicate whose first feed is within the recent window', () => {
      for (let i = 0; i < 900; i++) metrics.recordFeed(`uuid-${i}`);
      metrics.recordFeed('reclaim-me');
      for (let i = 900; i < 1200; i++) metrics.recordFeed(`uuid-${i}`);
      metrics.recordFeed('reclaim-me');
      const snap = metrics.snapshot();
      expect(snap.duplicateUuids).toContain('reclaim-me');
    });
  });
});
