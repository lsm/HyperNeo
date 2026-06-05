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
   * Record that a compaction was triggered. Resets the cooldown clock.
   */
  markCompactionTriggered(): void {
    this.lastCompactionTriggerAt = Date.now();
  }
}
