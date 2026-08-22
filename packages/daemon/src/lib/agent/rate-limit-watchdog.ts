import type { FallbackModelEntry, MessageContent } from '@hyperneo/shared';
import { Logger } from '../logger';
import {
  BACKOFF_LADDER_MS,
  type CooldownDecision,
  classifyLimitKind,
  computeCooldown,
  entryKey,
  MAX_RESET_HORIZON_MS,
  selectNextFallback,
} from './fallback-recovery';
import { cooldownFromReset, type LimitRetryHint } from './limit-error-classifier';
import type { ProcessingStateManager } from './processing-state-manager';

export interface RateLimitWatchdogConfig {
  cooldownMs: number;
  maxAutoRetries: number;
}

const DEFAULT_CONFIG: RateLimitWatchdogConfig = {
  cooldownMs: 10 * 60 * 1000,
  maxAutoRetries: BACKOFF_LADDER_MS.length,
};

const STARTUP_RETRY_DELAY_MS = 60 * 1000;
const MAX_STARTUP_RETRIES = 3;

export type RateLimitWatchdogStatus = 'idle' | 'cooldown' | 'fallback-pending';

export interface RateLimitWatchdogState {
  status: RateLimitWatchdogStatus;
  retryCount: number;
  maxRetries: number;
  retryAt: number | null;
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null;
  triedEntries: string[];
  fallbackChain: FallbackModelEntry[] | null;
  fallbackPending: boolean;
  limitKind: 'rate_limit' | 'usage_limit' | null;
}

export interface RateLimitPausePayload {
  kind: 'rate_limit' | 'usage_limit';
  resetAt?: number;
  reason: string;
}

export interface RateLimitWatchdogDeps {
  getCurrentModel(): { provider: string; model: string };
  resolveChain(): Promise<FallbackModelEntry[]>;
  isEntryAvailable(entry: FallbackModelEntry): Promise<boolean>;
  switchAndRetry(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry,
    episodeGeneration: number
  ): Promise<boolean>;
  resolveModelId?(provider: string, model: string): Promise<string>;
  notifyPause?(payload: RateLimitPausePayload): void;
  notifyResume?(): void;
}

export type RateLimitRetryCallback = (
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
  switchTo: FallbackModelEntry | undefined,
  episodeGeneration: number
) => Promise<boolean>;

export class RateLimitWatchdog {
  private logger: Logger;
  private config: RateLimitWatchdogConfig;
  private deps: RateLimitWatchdogDeps;
  private retryCount = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUserMessage: { uuid: string; content: string | MessageContent[] } | null = null;
  private lastErrorMessage = '';
  private retryCallback: RateLimitRetryCallback | null = null;
  private stateManager: ProcessingStateManager;

  private triedKeys = new Set<string>();
  private chain: FallbackModelEntry[] | null = null;
  private fallbackPending = false;
  private limitKind: 'rate_limit' | 'usage_limit' | null = null;
  private paused = false;
  private generation = 0;
  private startupRetries = 0;
  private startupExhausted = false;
  private bannerCancelled = false;
  private episodeMessageUuid: string | null = null;
  private lastHint: LimitRetryHint | null = null;

  constructor(
    sessionId: string,
    stateManager: ProcessingStateManager,
    deps: RateLimitWatchdogDeps,
    config?: Partial<RateLimitWatchdogConfig>
  ) {
    this.logger = new Logger(`RateLimitWatchdog ${sessionId}`);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateManager = stateManager;
    this.deps = deps;
  }

  setRetryCallback(callback: RateLimitRetryCallback): void {
    this.retryCallback = callback;
  }

  getState(): RateLimitWatchdogState {
    const retryAt = this.cooldownTimer !== null ? Date.now() + this.getRemainingMs() : null;

    return {
      status: this.fallbackPending
        ? 'fallback-pending'
        : this.cooldownTimer !== null
          ? 'cooldown'
          : 'idle',
      retryCount: this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
      lastUserMessage: this.lastUserMessage,
      triedEntries: [...this.triedKeys],
      fallbackChain: this.chain,
      fallbackPending: this.fallbackPending,
      limitKind: this.limitKind,
    };
  }

  async scheduleRetry(
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    hint?: LimitRetryHint
  ): Promise<boolean> {
    const entryGeneration = this.generation;

    this.cancelCooldownTimer();
    this.lastErrorMessage = errorMessage;
    if (hint) this.lastHint = hint;

    if (!lastUserMessage) {
      this.logger.warn('Cannot schedule rate limit recovery: no user message to retry.');
      return false;
    }
    this.lastUserMessage = lastUserMessage;

    if (this.episodeMessageUuid !== lastUserMessage.uuid) {
      this.episodeMessageUuid = lastUserMessage.uuid;
      this.triedKeys.clear();
      this.chain = null;
      this.retryCount = 0;
      this.startupRetries = 0;
      this.startupExhausted = false;
      this.bannerCancelled = false;
      this.lastHint = hint ?? null;
    }

    const { provider, model } = this.deps.getCurrentModel();
    const currentCanonical = (await this.deps.resolveModelId?.(provider, model)) ?? model;
    this.triedKeys.add(`${provider}/${currentCanonical}`);

    if (this.chain === null) {
      this.chain = await this.deps.resolveChain();
    }

    if (this.chain.length > 0) {
      const availability = new Map<FallbackModelEntry, boolean>();
      const canonicalKey = new Map<FallbackModelEntry, string>();
      await Promise.all(
        this.chain.map(async (entry) => {
          availability.set(entry, await this.deps.isEntryAvailable(entry));
          const canonical =
            (await this.deps.resolveModelId?.(entry.provider, entry.model)) ?? entry.model;
          canonicalKey.set(entry, `${entry.provider}/${canonical}`);
        })
      );
      const sel = selectNextFallback(
        this.chain,
        this.triedKeys,
        (e) => availability.get(e) === true,
        (e) => canonicalKey.get(e) ?? entryKey(e)
      );

      if (sel.next) {
        if (entryGeneration !== this.generation) {
          this.logger.info(
            'Fallback resolution completed but episode was superseded; aborting switch.'
          );
          return true;
        }
        this.logger.info(
          `Fallback: switching to ${sel.next.provider}/${sel.next.model} ` +
            `(skipReason for prior candidates: ${sel.skipReason}).`
        );
        this.fallbackPending = true;
        void this.fireImmediateFallback(lastUserMessage, sel.next, entryGeneration);
        return true;
      }
      this.logger.info(
        `Fallback chain exhausted (${sel.skipReason}); falling through to cooldown.`
      );
    }

    if (this.lastHint?.billingTerminal) {
      this.logger.warn(
        `Billing-cycle limit with no available fallback; surfacing instead of cooling down. ` +
          `Error: ${errorMessage}`
      );
      return false;
    }

    const now = Date.now();
    const hintedReset = this.lastHint?.resetAtMs ?? null;
    const usableHintedReset =
      hintedReset !== null && hintedReset > now && hintedReset < now + MAX_RESET_HORIZON_MS
        ? hintedReset
        : null;
    const decision =
      usableHintedReset !== null
        ? cooldownFromReset(usableHintedReset, now)
        : computeCooldown(errorMessage, this.retryCount, now);

    if (!decision.freeWait && this.retryCount >= this.config.maxAutoRetries) {
      this.logger.warn(
        `Max auto-retries (${this.config.maxAutoRetries}) exceeded for 429 error. Giving up. ` +
          `Error: ${errorMessage}`
      );
      return false;
    }
    if (!decision.freeWait) {
      this.retryCount++;
    }

    if (entryGeneration !== this.generation) {
      this.logger.info(
        'Cooldown resolution completed but episode was superseded; aborting schedule.'
      );
      return true;
    }

    await this.scheduleCooldown(errorMessage, decision, entryGeneration);
    return true;
  }

  private async scheduleCooldown(
    errorMessage: string,
    decision: CooldownDecision,
    episodeGeneration: number
  ): Promise<void> {
    const kind = this.lastHint?.kind ?? classifyLimitKind(errorMessage, decision);
    this.limitKind = kind;

    const retryAt = decision.retryAtMs;
    this.logger.info(
      `Scheduling cooldown (${decision.reason}, kind=${kind}) in ${decision.delayMs}ms. ` +
        `Error: ${errorMessage}`
    );

    await this.stateManager.setRateLimitCooldown({
      retryCount: this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
    });

    if (episodeGeneration !== this.generation) {
      this.logger.info(
        'Episode superseded during cooldown state write; not publishing pause or arming.'
      );
      return;
    }

    this.notifyPause({
      kind,
      resetAt: decision.retryAtMs,
      reason: decision.reason,
    });

    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.logger.info(
        `Cooldown elapsed; firing retry (step ${this.retryCount}/${this.config.maxAutoRetries}).`
      );
      void this.fireCooldownRetry(errorMessage);
    }, decision.delayMs);

    if (
      this.cooldownTimer &&
      typeof this.cooldownTimer === 'object' &&
      'unref' in this.cooldownTimer
    ) {
      this.cooldownTimer.unref();
    }
  }

  private async fireCooldownRetry(errorMessage: string): Promise<void> {
    const entryGeneration = this.generation;
    if (!this.retryCallback) {
      if (entryGeneration === this.generation) this.notifyResume();
      return;
    }
    let started = false;
    try {
      started = await this.retryCallback(this.lastUserMessage, undefined, entryGeneration);
    } catch (err) {
      this.logger.error('Cooldown retry callback threw; rescheduling a startup retry:', err);
      started = false;
    }
    if (entryGeneration !== this.generation) {
      this.logger.info('Cooldown retry completed but episode was superseded; aborting.');
      return;
    }
    if (started) {
      this.startupRetries = 0;
      this.startupExhausted = false;
      this.notifyResume();
      return;
    }

    this.startupRetries += 1;
    if (this.startupRetries > MAX_STARTUP_RETRIES) {
      this.logger.error(
        `Cooldown retry failed to start the query ${MAX_STARTUP_RETRIES} times; giving up automatic retry. Keeping the task paused (rate/usage-limited); manual Retry Now / Resume remains available.`
      );
      this.startupRetries = 0;
      this.startupExhausted = true;
      return;
    }
    this.logger.warn(
      `Cooldown retry did not start the query; startup retry ${this.startupRetries}/${MAX_STARTUP_RETRIES} in ${STARTUP_RETRY_DELAY_MS}ms.`
    );
    try {
      await this.stateManager.setRateLimitCooldown({
        retryCount: this.retryCount,
        maxRetries: this.config.maxAutoRetries,
        retryAt: Date.now() + STARTUP_RETRY_DELAY_MS,
      });
    } catch (err) {
      this.logger.warn('Failed to restore rate_limit_cooldown before startup retry:', err);
    }
    if (entryGeneration !== this.generation) {
      this.logger.info(
        'Startup retry aborted after state write (episode superseded); not re-arming.'
      );
      return;
    }
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      void this.fireCooldownRetry(errorMessage);
    }, STARTUP_RETRY_DELAY_MS);
    if (
      this.cooldownTimer &&
      typeof this.cooldownTimer === 'object' &&
      'unref' in this.cooldownTimer
    ) {
      this.cooldownTimer.unref();
    }
  }

  private async fireImmediateFallback(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry,
    episodeGeneration: number
  ): Promise<void> {
    if (episodeGeneration !== this.generation) {
      this.logger.info('Immediate fallback aborted before start (episode superseded).');
      this.fallbackPending = false;
      return;
    }

    let ok = false;
    try {
      ok = await this.deps.switchAndRetry(lastUserMessage, entry, episodeGeneration);
    } catch (err) {
      this.logger.error(
        `Fallback switch to ${entry.provider}/${entry.model} threw; advancing to next entry:`,
        err
      );
      ok = false;
    } finally {
      this.fallbackPending = false;
    }

    if (episodeGeneration !== this.generation) {
      this.logger.info(
        'Immediate fallback superseded mid-switch (cancel/reset); skipping chain advance + re-enqueue.'
      );
      return;
    }

    if (ok) {
      return;
    }
    const canonical =
      (await this.deps.resolveModelId?.(entry.provider, entry.model)) ?? entry.model;
    if (episodeGeneration !== this.generation) {
      this.logger.info('Fallback re-entry aborted after canonical resolve (episode superseded).');
      return;
    }
    this.triedKeys.add(`${entry.provider}/${canonical}`);
    if (this.lastUserMessage) {
      try {
        const scheduled = await this.scheduleRetry(
          this.lastErrorMessage,
          this.lastUserMessage,
          this.lastHint ?? undefined
        );
        if (!scheduled) {
          if (this.lastHint?.billingTerminal) {
            if (episodeGeneration !== this.generation) {
              this.logger.info(
                'Billing surfacing aborted (episode superseded) after fallback re-entry failed.'
              );
              return;
            }
            this.logger.warn(
              'Billing-cycle limit persisted after the fallback switch failed; ' +
                'surfacing a manual-retry pause instead of abandoning the request.'
            );
            this.limitKind = this.lastHint.kind ?? 'usage_limit';
            await this.stateManager.setRateLimitCooldown({
              retryCount: this.retryCount,
              maxRetries: this.config.maxAutoRetries,
              retryAt: Date.now(),
            });
            this.notifyPause({ kind: this.limitKind, reason: 'billing-terminal' });
          } else {
            this.logger.warn(
              'Fallback re-entry returned false (budget exhausted); scheduling a deferred cooldown.'
            );
            await this.scheduleCooldown(
              this.lastErrorMessage,
              computeCooldown(this.lastErrorMessage, this.retryCount),
              episodeGeneration
            );
          }
        }
      } catch (err) {
        this.logger.error('Fallback re-entry rejected; scheduling a deferred cooldown:', err);
        try {
          await this.scheduleCooldown(
            this.lastErrorMessage,
            computeCooldown(this.lastErrorMessage, this.retryCount),
            episodeGeneration
          );
        } catch {
          // Nothing more we can do; the caller (query-runner) will surface the
          // original 429 via its normal error path on the next message.
        }
      }
    }
  }

  cancel(notifyResume = true): void {
    this.generation++;
    this.cancelCooldownTimer();
    this.fallbackPending = false;
    this.startupExhausted = false;
    this.episodeMessageUuid = null;
    this.lastUserMessage = null;
    if (notifyResume) {
      this.notifyResume();
    } else {
      this.bannerCancelled = true;
    }
  }

  clearPendingCooldown(): void {
    this.cancelCooldownTimer();
    this.fallbackPending = false;
  }

  isSuperseded(generation: number): boolean {
    return generation !== this.generation;
  }

  getGeneration(): number {
    return this.generation;
  }

  private cancelCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.logger.info('Cancelled pending rate limit cooldown.');
    }
  }

  retryNow(): boolean {
    if (this.fallbackPending) {
      return false;
    }
    if (this.cooldownTimer === null && !this.startupExhausted) {
      return false;
    }

    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.startupExhausted) {
      this.startupExhausted = false;
      this.startupRetries = 0;
    }

    this.logger.info(
      `Immediate retry triggered (step ${this.retryCount}/${this.config.maxAutoRetries}).`
    );
    void this.fireCooldownRetry(this.lastErrorMessage);
    return true;
  }

  reset(): void {
    this.cancel();
    this.retryCount = 0;
    this.startupRetries = 0;
    this.startupExhausted = false;
    this.bannerCancelled = false;
    this.lastUserMessage = null;
    this.lastErrorMessage = '';
    this.triedKeys.clear();
    this.chain = null;
    this.limitKind = null;
    this.lastHint = null;
  }

  private getRemainingMs(): number {
    const state = this.stateManager.getState();
    if (state.status === 'rate_limit_cooldown') {
      return Math.max(0, state.retryAt - Date.now());
    }
    return 0;
  }

  isPending(): boolean {
    return this.cooldownTimer !== null;
  }

  isRateLimitBannerCancelled(): boolean {
    return this.bannerCancelled;
  }

  private notifyPause(payload: RateLimitPausePayload): void {
    this.paused = true;
    this.bannerCancelled = false;
    try {
      this.deps.notifyPause?.(payload);
    } catch (err) {
      this.logger.warn('notifyPause callback threw:', err);
    }
  }

  private notifyResume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.bannerCancelled = false;
    try {
      this.deps.notifyResume?.();
    } catch (err) {
      this.logger.warn('notifyResume callback threw:', err);
    }
  }

  destroy(): void {
    this.cancel();
    this.retryCallback = null;
  }
}
