/**
 * Delivery exactly-once observability metrics (task #861 item 13).
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { DeliveryMetrics } from '../../../../src/lib/agent/message-delivery-metrics';

describe('DeliveryMetrics (task #861 item 13)', () => {
  let metrics: DeliveryMetrics;

  beforeEach(() => {
    metrics = new DeliveryMetrics();
  });

  describe('feed-count-per-UUID (ground-truth duplicate detector)', () => {
    it('counts distinct UUIDs handed off and starts each at one feed', () => {
      metrics.recordFeed('a');
      metrics.recordFeed('b');
      const snap = metrics.snapshot();
      expect(snap.feedsObserved).toBe(2);
      expect(snap.duplicateFeedCount).toBe(0);
    });

    it('flags a UUID fed more than once as a real exactly-once breach', () => {
      metrics.recordFeed('dup');
      metrics.recordFeed('dup');
      metrics.recordFeed('solo');
      const snap = metrics.snapshot();
      expect(snap.duplicateFeedCount).toBe(1);
      expect(snap.duplicateUuids).toContain('dup');
      expect(snap.feedsObserved).toBe(2); // distinct UUIDs
    });

    it('does not flag a UUID fed once', () => {
      metrics.recordFeed('once');
      expect(metrics.snapshot().duplicateFeedCount).toBe(0);
    });
  });

  describe('reclaim-outcome breakdown (duplicates prevented)', () => {
    it('counts each outcome kind independently', () => {
      metrics.recordReclaimOutcome('alreadyConsumed');
      metrics.recordReclaimOutcome('alreadyConsumed');
      metrics.recordReclaimOutcome('alreadySubmitted');
      metrics.recordReclaimOutcome('stillEnqueued');
      metrics.recordReclaimOutcome('noContent');
      const { reclaimOutcomes } = metrics.snapshot();
      expect(reclaimOutcomes).toEqual({
        alreadyConsumed: 2,
        alreadySubmitted: 1,
        stillEnqueued: 1,
        noContent: 1,
      });
    });

    it('alreadyConsumed + alreadySubmitted are the duplicates-prevented leading indicator', () => {
      metrics.recordReclaimOutcome('alreadyConsumed');
      metrics.recordReclaimOutcome('alreadySubmitted');
      const { reclaimOutcomes } = metrics.snapshot();
      // Non-zero prevented counts mean the synchronous consumed-flip + skip are working.
      expect(reclaimOutcomes.alreadyConsumed + reclaimOutcomes.alreadySubmitted).toBeGreaterThan(0);
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
      // rank = p*(n-1); P50 = 5.5, P99 = 9 + (10-9)*0.91 = 9.91 (linear interp).
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
});
