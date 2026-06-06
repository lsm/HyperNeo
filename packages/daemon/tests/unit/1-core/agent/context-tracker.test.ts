/**
 * ContextTracker Tests
 *
 * Tests context window usage tracking backed by the SDK's native
 * `query.getContextUsage()` (adapted via `ContextFetcher`).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { ContextInfo } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';

describe('ContextTracker', () => {
  let tracker: ContextTracker;
  let persistSpy: ReturnType<typeof mock>;
  const testSessionId = generateUUID();
  const testModel = 'claude-sonnet-4-5-20250929';

  beforeEach(() => {
    persistSpy = mock(() => {});
    tracker = new ContextTracker(testSessionId, persistSpy);
  });

  describe('initial state', () => {
    it('should start with null context info', () => {
      expect(tracker.getContextInfo()).toBeNull();
    });
  });

  describe('restore from metadata', () => {
    it('should restore context info from saved metadata', () => {
      const savedContext: ContextInfo = {
        model: testModel,
        totalUsed: 50000,
        totalCapacity: 200000,
        percentUsed: 25,
        breakdown: {
          'System prompt': { tokens: 3000, percent: 1.5 },
          Messages: { tokens: 47000, percent: 23.5 },
          'Free space': { tokens: 150000, percent: 75 },
        },
      };

      tracker.restoreFromMetadata(savedContext);

      const restored = tracker.getContextInfo();
      expect(restored).toEqual(savedContext);
    });
  });

  describe('updateWithDetailedBreakdown', () => {
    it('should update context info and persist', () => {
      const contextInfo: ContextInfo = {
        model: testModel,
        totalUsed: 30000,
        totalCapacity: 200000,
        percentUsed: 15,
        breakdown: {
          'System prompt': { tokens: 5000, percent: 2.5 },
          Messages: { tokens: 25000, percent: 12.5 },
          'Free space': { tokens: 170000, percent: 85 },
        },
        source: 'sdk-get-context-usage',
      };

      tracker.updateWithDetailedBreakdown(contextInfo);

      expect(tracker.getContextInfo()).toEqual(contextInfo);
      expect(persistSpy).toHaveBeenCalledWith(contextInfo);
    });

    it('should overwrite previous context info', () => {
      const first: ContextInfo = {
        model: testModel,
        totalUsed: 10000,
        totalCapacity: 200000,
        percentUsed: 5,
        breakdown: {},
      };
      const second: ContextInfo = {
        model: testModel,
        totalUsed: 20000,
        totalCapacity: 200000,
        percentUsed: 10,
        breakdown: {},
      };

      tracker.updateWithDetailedBreakdown(first);
      tracker.updateWithDetailedBreakdown(second);

      expect(tracker.getContextInfo()).toEqual(second);
      expect(persistSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('model switching', () => {
    it('should not throw when setModel is called', () => {
      expect(() => tracker.setModel('claude-opus-4-6')).not.toThrow();
    });
  });

  describe('shouldCompact', () => {
    it('returns false when no context info exists', () => {
      expect(tracker.shouldCompact(200_000)).toBe(false);
    });

    it('returns false when usage is below 85% threshold', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-4',
        totalUsed: 100_000,
        totalCapacity: 128_000,
        percentUsed: 78,
        breakdown: {},
      });
      expect(tracker.shouldCompact(128_000)).toBe(false);
    });

    it('returns true when usage is at or above 85% threshold', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-4',
        totalUsed: 109_000,
        totalCapacity: 128_000,
        percentUsed: 85,
        breakdown: {},
      });
      expect(tracker.shouldCompact(128_000)).toBe(true);
    });

    it('returns false when cooldown has not elapsed', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-4',
        totalUsed: 109_000,
        totalCapacity: 128_000,
        percentUsed: 85,
        breakdown: {},
      });
      tracker.markCompactionTriggered();
      expect(tracker.shouldCompact(128_000, 60_000)).toBe(false);
    });

    it('returns true after cooldown elapses', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-4',
        totalUsed: 109_000,
        totalCapacity: 128_000,
        percentUsed: 85,
        breakdown: {},
      });
      tracker.markCompactionTriggered();
      expect(tracker.shouldCompact(128_000, 0)).toBe(true);
    });

    it('returns false for invalid context window', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-4',
        totalUsed: 109_000,
        totalCapacity: 128_000,
        percentUsed: 85,
        breakdown: {},
      });
      expect(tracker.shouldCompact(0)).toBe(false);
      expect(tracker.shouldCompact(-1)).toBe(false);
    });
  });
});
