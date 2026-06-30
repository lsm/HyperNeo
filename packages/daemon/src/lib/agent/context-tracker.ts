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
 * The SDK's own auto-compact buffer. The SDK computes its trigger as
 * `autoCompactWindow − min(maxOutputTokens, 20000) − 13000`, so the buffer it
 * keeps below the window is `min(maxOutputTokens, 20000) + 13000`. Every modern
 * model has a default max output ≥ 20000, so the first term caps at 20000 and
 * the buffer is a flat 33_000. NeoKai's fallback uses the same buffer so it
 * fires at the same point the SDK would have — for most providers this is a
 * safe default.
 */
const SDK_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

/**
 * Kimi-specific reserve buffer.
 *
 * Kimi's "Prompt is too long" is the Claude Agent SDK's CLIENT-SIDE pre-flight
 * check, not a Moonshot server response. No Kimi route (China `kimi-for-coding`
 * or Global `kimi-k2.7-code`) is recognised by the SDK's context-window
 * resolver, so the SDK falls back to its 200k window and clamps
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW to 200k. Its pre-flight check then
 * short-circuits with the bare "Prompt is too long" (duration_ms 3–7 — no
 * network round-trip is possible in that time) once its context estimate nears
 * ~176k (200k minus an output reserve). The detailed "N tokens > M maximum"
 * form, by contrast, is the server (Anthropic). The SDK clamps the window
 * itself, so NeoKai cannot make it gate higher — the only lever is to compact
 * before that ~176k gate.
 *
 * Reserve 112k so the trigger fires at 262144 − 112000 = 150144. The trigger
 * compares the SDK's own `totalTokens` (via contextInfo.totalUsed) — the same
 * metric the SDK gate checks — so 150144 reliably precedes ~176k, with ~26k of
 * headroom for within-turn growth between the trigger firing (every 5 events +
 * turn-end) and /compact running. (daemon.db, kimi-for-coding, 2026-06:
 * rejections clustered at 170–177k total context; the previous 45k reserve
 * gated at 217k, above the SDK gate, so it never fired.)
 */
const KIMI_RESERVE_TOKENS = 112_000;

/**
 * Compute the NeoKai fallback threshold for a context window: the point below
 * the window at which NeoKai should trigger compaction. The default reserve
 * matches the SDK's own 33k buffer; Kimi uses a larger 112k reserve because
 * the SDK client-side rejects at ~176k against its clamped 200k window (see
 * KIMI_RESERVE_TOKENS). Result is floored at 1 so tiny windows still produce a
 * positive threshold.
 */
export function reserveBasedThreshold(contextWindow: number, providerId?: string): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = providerId === 'kimi' ? KIMI_RESERVE_TOKENS : SDK_AUTO_COMPACT_RESERVE_TOKENS;
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
