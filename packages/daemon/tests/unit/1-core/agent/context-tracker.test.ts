import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ContextTracker, reserveBasedThreshold } from '../../../../src/lib/agent/context-tracker';
import type { ContextInfo } from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';

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

    it('triggers at exactly 85% of the GPT-5.5 272k context window', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'gpt-5.5',
        totalUsed: 231_199,
        totalCapacity: 272_000,
        percentUsed: 85,
        breakdown: {},
      });
      expect(tracker.shouldCompact(272_000)).toBe(false);

      tracker.updateWithDetailedBreakdown({
        model: 'gpt-5.5',
        totalUsed: 231_200,
        totalCapacity: 272_000,
        percentUsed: 85,
        breakdown: {},
      });
      expect(tracker.shouldCompact(272_000)).toBe(true);
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

  describe('shouldCompactAt', () => {
    it('returns false when no context info exists', () => {
      expect(tracker.shouldCompactAt(100_000)).toBe(false);
    });

    it('returns false when totalUsed is below threshold', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'kimi-for-coding',
        totalUsed: 200_000,
        totalCapacity: 262_144,
        percentUsed: 76,
        breakdown: {},
      });
      expect(tracker.shouldCompactAt(217_144)).toBe(false);
    });

    it('returns true when totalUsed is at or above threshold', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'kimi-for-coding',
        totalUsed: 250_000,
        totalCapacity: 262_144,
        percentUsed: 95,
        breakdown: {},
      });
      expect(tracker.shouldCompactAt(217_144)).toBe(true);
    });

    it('returns false when cooldown has not elapsed', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'kimi-for-coding',
        totalUsed: 250_000,
        totalCapacity: 262_144,
        percentUsed: 95,
        breakdown: {},
      });
      tracker.markCompactionTriggered();
      expect(tracker.shouldCompactAt(217_144, 60_000)).toBe(false);
    });

    it('returns true after cooldown elapses', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'kimi-for-coding',
        totalUsed: 250_000,
        totalCapacity: 262_144,
        percentUsed: 95,
        breakdown: {},
      });
      tracker.markCompactionTriggered();
      expect(tracker.shouldCompactAt(217_144, 0)).toBe(true);
    });

    it('returns false for invalid threshold', () => {
      tracker.updateWithDetailedBreakdown({
        model: 'kimi-for-coding',
        totalUsed: 250_000,
        totalCapacity: 262_144,
        percentUsed: 95,
        breakdown: {},
      });
      expect(tracker.shouldCompactAt(0)).toBe(false);
      expect(tracker.shouldCompactAt(-1)).toBe(false);
      expect(tracker.shouldCompactAt(Number.NaN)).toBe(false);
    });
  });

  describe('budget-keyed compaction cooldown', () => {
    it('suppresses re-arming for the same budget within the cooldown', () => {
      tracker.markCompactionTriggered(115_200);
      expect(tracker.isCoolingDown(115_200, 60_000)).toBe(true);
    });

    it('allows re-arming immediately when the active budget changed', () => {
      tracker.markCompactionTriggered(900_000);
      expect(tracker.isCoolingDown(115_200, 60_000)).toBe(false);
    });

    it('a boundary mark without a budget key suppresses every budget', () => {
      tracker.markCompactionTriggered();
      expect(tracker.isCoolingDown(115_200, 60_000)).toBe(true);
      expect(tracker.isCoolingDown(900_000, 60_000)).toBe(true);
    });

    it('clearing the cooldown re-arms the backstop immediately', () => {
      tracker.markCompactionTriggered(115_200);
      tracker.clearCompactionCooldown();
      expect(tracker.isCoolingDown(115_200, 60_000)).toBe(false);
    });
  });

  describe('reserveBasedThreshold', () => {
    it('returns 0 for invalid context windows', () => {
      expect(reserveBasedThreshold(0)).toBe(0);
      expect(reserveBasedThreshold(-1)).toBe(0);
      expect(reserveBasedThreshold(Number.NaN)).toBe(0);
    });

    it('uses the SDK 33k buffer for normal-sized windows', () => {
      expect(reserveBasedThreshold(200_000)).toBe(167_000);
      expect(reserveBasedThreshold(200_000, 'anthropic')).toBe(167_000);
      expect(reserveBasedThreshold(200_000, 'glm')).toBe(167_000);
      expect(reserveBasedThreshold(1_000_000)).toBe(967_000);
    });

    it('uses the larger 45k reserve for Kimi to cover ~32k output + reasoning', () => {
      expect(reserveBasedThreshold(262_144, 'kimi')).toBe(217_144);
    });

    it('keeps the default 33k reserve for non-Kimi providers even on a 262k window', () => {
      expect(reserveBasedThreshold(262_144, 'openrouter')).toBe(229_144);
      expect(reserveBasedThreshold(262_144)).toBe(229_144);
    });

    it('clamps the threshold to at least 1 for windows at or below the buffer', () => {
      expect(reserveBasedThreshold(80_000)).toBe(47_000);
      expect(reserveBasedThreshold(8_000)).toBe(1);
      expect(reserveBasedThreshold(100)).toBe(1);
      expect(reserveBasedThreshold(1)).toBe(1);
      expect(reserveBasedThreshold(44_000, 'kimi')).toBe(1);
    });

    it('matches SDK trigger for GLM 1M window', () => {
      expect(reserveBasedThreshold(1_000_000, 'glm')).toBe(967_000);
    });
  });
});
