/**
 * ContextTracker - Context window usage tracking
 *
 * Context info is obtained from the Claude Agent SDK's native
 * `query.getContextUsage()` method (adapted via `ContextFetcher`).
 * It's refreshed every N stream events, at every turn end, and after
 * context compaction.
 */

import type { ContextInfo } from '@neokai/shared';

export class ContextTracker {
  /**
   * Current context info - the latest snapshot of context window usage.
   * Updated by SDKMessageHandler via `updateWithDetailedBreakdown()`.
   */
  private currentContextInfo: ContextInfo | null = null;

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
}
