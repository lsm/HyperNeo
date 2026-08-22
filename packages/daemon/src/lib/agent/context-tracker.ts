import type { ContextInfo } from '@hyperneo/shared';

const DEFAULT_COMPACTION_COOLDOWN_MS = 60_000;

export const COMPACTION_THRESHOLD = 0.85;

const SDK_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

const KIMI_RESERVE_TOKENS = 45_000;

export function reserveBasedThreshold(contextWindow: number, providerId?: string): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const reserve = providerId === 'kimi' ? KIMI_RESERVE_TOKENS : SDK_AUTO_COMPACT_RESERVE_TOKENS;
  return Math.max(1, contextWindow - reserve);
}

export class ContextTracker {
  private currentContextInfo: ContextInfo | null = null;

  private lastCompactionTriggerAt = 0;

  constructor(
    private sessionId: string,
    private persistContext: (info: ContextInfo) => void
  ) {}

  getContextInfo(): ContextInfo | null {
    return this.currentContextInfo;
  }

  restoreFromMetadata(savedContext: ContextInfo): void {
    this.currentContextInfo = savedContext;
  }

  updateWithDetailedBreakdown(contextInfo: ContextInfo): void {
    this.currentContextInfo = contextInfo;
    this.persistContext(contextInfo);
  }

  setModel(_model: string): void {}

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

  markCompactionTriggered(): void {
    this.lastCompactionTriggerAt = Date.now();
  }
}
