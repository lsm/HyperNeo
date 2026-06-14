/**
 * ContextTracker - Context window usage tracking
 *
 * Context info is obtained from the Claude Agent SDK's native
 * `query.getContextUsage()` method (adapted via `ContextFetcher`).
 * It's refreshed every N stream events, at every turn end, and after
 * context compaction.
 */

import type { ContextInfo } from '@neokai/shared';

/**
 * Default cooldown between NeoKai-triggered compactions (ms).
 * Prevents rapid-fire /compact commands when context stays near the limit.
 */
const DEFAULT_COMPACTION_COOLDOWN_MS = 60_000;

/**
 * Fraction of the model's actual context window at which NeoKai triggers
 * compaction for non-native providers.
 */
export const COMPACTION_THRESHOLD = 0.85;

/**
 * Reserve used by `reserveBasedThreshold` to compute a NeoKai fallback
 * threshold that sits above the SDK's own auto-compact trigger.
 *
 * The SDK fires compaction at `window - 13_000`. To leave the SDK a chance to
 * fire first (so NeoKai is a true safety net), NeoKai's threshold must be at
 * least `window - 13_000`. For larger windows, 15 % gives NeoKai a wider
 * margin so the SDK has multiple turns to react before NeoKai intervenes.
 */
const SDK_AUTO_COMPACT_RESERVE_TOKENS = 13_000;
const RESERVE_FRACTION = 0.15;

/**
 * Compute the NeoKai fallback threshold for a context window. Returns
 * `window - max(13_000, 0.15 * window)` so NeoKai fires only when the SDK's
 * own auto-compact (which fires at `window - 13_000`) has not kept up.
 */
export function reserveBasedThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = Math.max(
    SDK_AUTO_COMPACT_RESERVE_TOKENS,
    Math.floor(contextWindow * RESERVE_FRACTION)
  );
  return Math.max(0, contextWindow - reserve);
}

export class ContextTracker {
  /**
   * Current context info - the latest snapshot of context window usage.
   * Updated by SDKMessageHandler via `updateWithDetailedBreakdown()`.
   */
  private currentContextInfo: ContextInfo | null = null;

  /**
   * Timestamp of the last compaction trigger (ms since epoch).
   * Used for cooldown gating.
   */
  private lastCompactionTriggerAt = 0;

  constructor(
    private sessionId: string,
    private persistContext: (info: ContextInfo) => void
  ) {}

  /**
   * Get current context info
   */
  getContextInfo(): ContextInfo | null {
    return this.currentContextInfo;
  }

  /**
   * Restore context info from session metadata (on session load)
   */
  restoreFromMetadata(savedContext: ContextInfo): void {
    this.currentContextInfo = savedContext;
  }

  /**
   * Update context info with detailed breakdown from the SDK.
   */
  updateWithDetailedBreakdown(contextInfo: ContextInfo): void {
    this.currentContextInfo = contextInfo;
    this.persistContext(contextInfo);
  }

  /**
   * Update model (no-op: model is now reported directly by the SDK).
   */
  setModel(_model: string): void {
    // Model is extracted from SDK getContextUsage() output, not tracked here.
  }

  /**
   * Check whether the context window is full enough that NeoKai should
   * trigger compaction for a non-native provider.
   *
   * Uses the *actual* model context window (from model metadata), NOT the
   * SDK-reported capacity which may be `Number.MAX_SAFE_INTEGER` after we
   * disabled SDK auto-compaction.
   *
   * Gated by a cooldown so we don't enqueue `/compact` repeatedly while the
   * SDK is still processing a previous compaction.
   */
  shouldCompact(actualContextWindow: number, cooldownMs = DEFAULT_COMPACTION_COOLDOWN_MS): boolean {
    const info = this.currentContextInfo;
    if (!info || actualContextWindow <= 0) {
      return false;
    }

    const threshold = Math.floor(actualContextWindow * COMPACTION_THRESHOLD);
    if (info.totalUsed < threshold) {
      return false;
    }

    if (Date.now() - this.lastCompactionTriggerAt < cooldownMs) {
      return false;
    }

    return true;
  }

  /**
   * Threshold-based variant of `shouldCompact`. Fires when `totalUsed` is at
   * or above `threshold` (an absolute token count, typically computed by
   * `reserveBasedThreshold(contextWindow)` so NeoKai stays behind the SDK's
   * own auto-compact trigger).
   *
   * Used by `sdk-message-handler` to install a NeoKai fallback that runs even
   * for providers where the SDK *reports* auto-compact as enabled but may not
   * actually fire (e.g. unknown model IDs whose PP() capacity caps below the
   * real window).
   */
  shouldCompactAt(threshold: number, cooldownMs = DEFAULT_COMPACTION_COOLDOWN_MS): boolean {
    const info = this.currentContextInfo;
    if (!info || !Number.isFinite(threshold) || threshold <= 0) {
      return false;
    }

    if (info.totalUsed < threshold) {
      return false;
    }

    if (Date.now() - this.lastCompactionTriggerAt < cooldownMs) {
      return false;
    }

    return true;
  }

  /**
   * Record that a compaction was triggered. Resets the cooldown clock.
   */
  markCompactionTriggered(): void {
    this.lastCompactionTriggerAt = Date.now();
  }
}
