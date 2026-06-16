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
 * The SDK's own auto-compact reserve. The SDK fires compaction at
 * `window - 13_000`. NeoKai's fallback uses the same reserve (clamped for
 * small windows) so it fires at the same point the SDK would have — for
 * providers in `PROVIDER_NO_SDK_AUTO_COMPACT` (e.g. Kimi) the SDK never
 * fires, so NeoKai is the sole compaction path and matching the SDK's
 * threshold gives consistent behaviour.
 */
const SDK_AUTO_COMPACT_RESERVE_TOKENS = 13_000;

/**
 * Cap on the SDK reserve as a fraction of the window. For small windows the
 * 13_000 fixed reserve can exceed 10% of the window (or even the whole
 * window), which would produce a zero or negative threshold. Scale the
 * reserve down proportionally so the threshold stays positive and meaningful.
 */
const RESERVE_FRACTION_CAP = 0.1;

/**
 * Compute the NeoKai fallback threshold for a context window. Uses the SDK's
 * own 13_000 token reserve, scaled down for small windows so the threshold
 * is always at least 1 token.
 *
 * This matches where the SDK's own auto-compact would have fired, so for
 * providers where the SDK is disabled (`PROVIDER_NO_SDK_AUTO_COMPACT`,
 * e.g. Kimi) NeoKai behaves consistently with the SDK's intended trigger
 * point.
 */
export function reserveBasedThreshold(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = Math.min(
    SDK_AUTO_COMPACT_RESERVE_TOKENS,
    Math.floor(contextWindow * RESERVE_FRACTION_CAP)
  );
  return Math.max(1, contextWindow - reserve);
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
