import type { FallbackModelEntry, MessageContent } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import {
  BACKOFF_LADDER_MS,
  type CooldownDecision,
  classifyLimitKind,
  computeCooldown,
  entryKey,
  selectNextFallback,
} from './fallback-recovery.ts';
import { cooldownFromReset, type LimitRetryHint } from './limit-error-classifier.ts';
import type { LlmLimitAssessment } from './limit-error-llm-classifier.ts';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import {
  canRetryNow,
  decideRateLimitTrip,
  manualRecoveryPause,
  type RateLimitWatchdogStatus,
  refinedResetAtMs,
  resolveWatchdogStatus,
} from './rate-limit-watchdog-gates.ts';

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
    episodeGeneration: number,
    queryGeneration?: number
  ): Promise<boolean>;
  resolveModelId?(provider: string, model: string): Promise<string>;
  getQueryGeneration?(): number;
  notifyPause?(payload: RateLimitPausePayload): void;
  notifyResume?(): void;
  classifyUnknownLimit?(rawText: string): Promise<LlmLimitAssessment | null>;
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
  private currentRetryAt: number | null = null;
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
  private billingPauseSurfaced = false;
  private retryCallbackInFlight = false;
  private retryCallbackInFlightOwner: number | null = null;

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
      status: resolveWatchdogStatus({
        fallbackPending: this.fallbackPending,
        cooldownActive: this.cooldownTimer !== null,
      }),
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
    hint?: LimitRetryHint,
    queryGeneration?: number
  ): Promise<boolean> {
    const entryGeneration = this.generation;
    const querySuperseded = (): boolean =>
      queryGeneration !== undefined &&
      this.deps.getQueryGeneration != null &&
      this.deps.getQueryGeneration() !== queryGeneration;

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
      this.billingPauseSurfaced = false;
      this.lastHint = hint ?? null;
    }

    const { provider, model } = this.deps.getCurrentModel();
    const currentCanonical = (await this.deps.resolveModelId?.(provider, model)) ?? model;
    if (querySuperseded()) {
      this.logger.info('Model resolution completed but the query was superseded; aborting.');
      return true;
    }
    this.triedKeys.add(`${provider}/${currentCanonical}`);

    if (this.chain === null) {
      const chain = await this.deps.resolveChain();
      if (querySuperseded()) {
        this.logger.info('Chain resolution completed but the query was superseded; aborting.');
        return true;
      }
      this.chain = chain;
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
      if (querySuperseded()) {
        this.logger.info(
          'Availability resolution completed but the query was superseded; aborting.'
        );
        return true;
      }
      const sel = selectNextFallback(
        this.chain,
        this.triedKeys,
        (e) => availability.get(e) === true,
        (e) => canonicalKey.get(e) ?? entryKey(e)
      );

      if (sel.next) {
        if (entryGeneration !== this.generation || querySuperseded()) {
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
        void this.fireImmediateFallback(
          lastUserMessage,
          sel.next,
          entryGeneration,
          queryGeneration
        );
        return true;
      }
      this.logger.info(
        `Fallback chain exhausted (${sel.skipReason}); falling through to cooldown.`
      );
    }

    const trip = decideRateLimitTrip({
      hint: this.lastHint,
      errorMessage,
      retryCount: this.retryCount,
      maxAutoRetries: this.config.maxAutoRetries,
      now: Date.now(),
    });
    if (trip.action === 'surface-billing') {
      this.logger.warn(
        `Billing-cycle limit with no available fallback; surfacing instead of cooling down. ` +
          `Error: ${errorMessage}`
      );
      return false;
    }
    if (trip.action === 'give-up') {
      this.logger.warn(
        `Max auto-retries (${this.config.maxAutoRetries}) exceeded for 429 error. Giving up. ` +
          `Error: ${errorMessage}`
      );
      return false;
    }
    if (trip.charge) {
      this.retryCount++;
    }

    if (entryGeneration !== this.generation || querySuperseded()) {
      this.logger.info(
        'Cooldown resolution completed but episode was superseded; aborting schedule.'
      );
      return true;
    }

    const armed = await this.scheduleCooldown(
      errorMessage,
      trip.decision,
      entryGeneration,
      undefined,
      queryGeneration
    );

    if (
      armed &&
      trip.decision.reason === 'backoff-ladder' &&
      this.deps.classifyUnknownLimit &&
      entryGeneration === this.generation
    ) {
      this.fireLlmRefinement(errorMessage, entryGeneration, trip.charge, queryGeneration);
    }
    return true;
  }

  private fireLlmRefinement(
    errorMessage: string,
    entryGeneration: number,
    chargedLadder: boolean,
    queryGeneration?: number
  ): void {
    const classify = this.deps.classifyUnknownLimit;
    if (!classify) return;
    const timerAtFire = this.cooldownTimer;
    void classify(errorMessage)
      .then(async (result) => {
        if (entryGeneration !== this.generation || this.cooldownTimer !== timerAtFire) return;
        if (
          queryGeneration !== undefined &&
          this.deps.getQueryGeneration != null &&
          this.deps.getQueryGeneration() !== queryGeneration
        ) {
          this.logger.info('LLM refinement completed but the query was superseded; aborting.');
          return;
        }
        if (!result) return;
        const now = Date.now();
        const resetMs = refinedResetAtMs(result, now);
        if (resetMs === null) return;
        this.logger.info(
          `LLM limit refinement: retry at ${new Date(resetMs).toISOString()} ` +
            `(was backoff ladder) for error: ${errorMessage}`
        );
        const previousHint = this.lastHint;
        const previousLimitKind = this.limitKind;
        if (result.kind) {
          this.lastHint = { ...this.lastHint, kind: result.kind };
        }
        const refinedHint = this.lastHint;
        const rollbackHintAndKind = () => {
          if (this.lastHint === refinedHint) {
            this.lastHint = previousHint;
          }
          if (this.limitKind === result.kind) {
            this.limitKind = previousLimitKind;
          }
        };
        const refund = chargedLadder && this.retryCount > 0;
        try {
          const armed = await this.scheduleCooldown(
            errorMessage,
            cooldownFromReset(resetMs, now),
            entryGeneration,
            refund ? this.retryCount - 1 : this.retryCount,
            queryGeneration
          );
          if (!armed) {
            rollbackHintAndKind();
          } else if (refund) {
            this.retryCount--;
          }
        } catch (err) {
          this.logger.warn('LLM refinement cooldown scheduling threw; reconciling state:', err);
          rollbackHintAndKind();
          if (this.cooldownTimer === timerAtFire && this.currentRetryAt !== null) {
            await this.stateManager
              .setRateLimitCooldown({
                retryCount: this.retryCount,
                maxRetries: this.config.maxAutoRetries,
                retryAt: this.currentRetryAt,
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  private async scheduleCooldown(
    errorMessage: string,
    decision: CooldownDecision,
    episodeGeneration: number,
    displayRetryCount?: number,
    queryGeneration?: number
  ): Promise<boolean> {
    if (
      queryGeneration !== undefined &&
      this.deps.getQueryGeneration != null &&
      this.deps.getQueryGeneration() !== queryGeneration
    ) {
      this.logger.info('Cooldown scheduling aborted: the originating query was superseded.');
      return false;
    }
    const kind = this.lastHint?.kind ?? classifyLimitKind(errorMessage, decision);
    this.limitKind = kind;

    const retryAt = decision.retryAtMs;
    this.logger.info(
      `Scheduling cooldown (${decision.reason}, kind=${kind}) in ${decision.delayMs}ms. ` +
        `Error: ${errorMessage}`
    );

    const timerAtEntry = this.cooldownTimer;
    await this.stateManager.setRateLimitCooldown({
      retryCount: displayRetryCount ?? this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
    });

    const cooldownQuerySuperseded =
      queryGeneration !== undefined &&
      this.deps.getQueryGeneration != null &&
      this.deps.getQueryGeneration() !== queryGeneration;
    if (
      episodeGeneration !== this.generation ||
      cooldownQuerySuperseded ||
      this.cooldownTimer !== timerAtEntry
    ) {
      this.logger.info(
        'Cooldown state write completed but a newer action owns the cooldown; ' +
          'not publishing pause or arming.'
      );
      await this.restoreCooldownStateForCurrentOwner(decision.retryAtMs, episodeGeneration);
      return false;
    }

    this.notifyPause({
      kind,
      resetAt: decision.retryAtMs,
      reason: decision.reason,
    });

    this.cancelCooldownTimer();
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.currentRetryAt = null;
      this.logger.info(
        `Cooldown elapsed; firing retry (step ${this.retryCount}/${this.config.maxAutoRetries}).`
      );
      void this.fireCooldownRetry(errorMessage);
    }, decision.delayMs);
    this.currentRetryAt = decision.retryAtMs;

    if (
      this.cooldownTimer &&
      typeof this.cooldownTimer === 'object' &&
      'unref' in this.cooldownTimer
    ) {
      this.cooldownTimer.unref();
    }
    return true;
  }

  private async fireCooldownRetry(errorMessage: string): Promise<void> {
    const entryGeneration = this.generation;
    this.retryCallbackInFlight = true;
    this.retryCallbackInFlightOwner = entryGeneration;
    try {
      await this.runCooldownRetry(errorMessage, entryGeneration);
    } finally {
      if (this.retryCallbackInFlightOwner === entryGeneration) {
        this.retryCallbackInFlight = false;
        this.retryCallbackInFlightOwner = null;
      }
    }
  }

  private async runCooldownRetry(errorMessage: string, entryGeneration: number): Promise<void> {
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
      this.currentRetryAt = null;
      void this.fireCooldownRetry(errorMessage);
    }, STARTUP_RETRY_DELAY_MS);
    this.currentRetryAt = Date.now() + STARTUP_RETRY_DELAY_MS;
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
    episodeGeneration: number,
    queryGeneration?: number
  ): Promise<void> {
    if (episodeGeneration !== this.generation) {
      this.logger.info('Immediate fallback aborted before start (episode superseded).');
      this.fallbackPending = false;
      return;
    }

    let ok = false;
    this.retryCallbackInFlight = true;
    this.retryCallbackInFlightOwner = episodeGeneration;
    try {
      ok = await this.deps.switchAndRetry(
        lastUserMessage,
        entry,
        episodeGeneration,
        queryGeneration
      );
    } catch (err) {
      this.logger.error(
        `Fallback switch to ${entry.provider}/${entry.model} threw; advancing to next entry:`,
        err
      );
      ok = false;
    } finally {
      if (this.retryCallbackInFlightOwner === episodeGeneration) {
        this.retryCallbackInFlight = false;
        this.retryCallbackInFlightOwner = null;
      }
      if (episodeGeneration === this.generation) {
        this.fallbackPending = false;
      }
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
          this.lastHint ?? undefined,
          queryGeneration
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
            this.startupExhausted = true;
            await this.stateManager.setRateLimitCooldown({
              retryCount: this.retryCount,
              maxRetries: this.config.maxAutoRetries,
              retryAt: Date.now(),
            });
            if (episodeGeneration !== this.generation) {
              this.logger.info(
                'Episode superseded during billing pause state write; not publishing pause.'
              );
              return;
            }
            this.notifyPause({ kind: this.limitKind, reason: 'billing-terminal' });
            this.billingPauseSurfaced = true;
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
        } catch {}
      }
    }
  }

  cancel(notifyResume = true): void {
    this.generation++;
    this.cancelCooldownTimer();
    this.fallbackPending = false;
    this.startupExhausted = false;
    this.billingPauseSurfaced = false;
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
      this.currentRetryAt = null;
      this.logger.info('Cancelled pending rate limit cooldown.');
    }
  }

  private async restoreCooldownStateForCurrentOwner(
    staleRetryAtMs: number,
    episodeGeneration: number
  ): Promise<void> {
    if (this.cooldownTimer !== null && this.currentRetryAt !== null) {
      if (this.currentRetryAt === staleRetryAtMs) return;
      await this.stateManager.setRateLimitCooldown({
        retryCount: this.retryCount,
        maxRetries: this.config.maxAutoRetries,
        retryAt: this.currentRetryAt,
      });
      return;
    }
    if (episodeGeneration === this.generation) {
      await this.stateManager.setRateLimitCooldown({
        retryCount: this.retryCount,
        maxRetries: this.config.maxAutoRetries,
        retryAt: Date.now(),
      });
    }
  }

  retryNow(): boolean {
    if (
      !canRetryNow({
        fallbackPending: this.fallbackPending,
        cooldownActive: this.cooldownTimer !== null,
        startupExhausted: this.startupExhausted,
      })
    ) {
      return false;
    }

    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.currentRetryAt = null;
    }
    if (this.startupExhausted) {
      this.startupExhausted = false;
      this.startupRetries = 0;
    }
    this.billingPauseSurfaced = false;

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
    this.billingPauseSurfaced = false;
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

  isRecoveryPending(): boolean {
    return (
      this.cooldownTimer !== null ||
      this.fallbackPending ||
      this.billingPauseSurfaced ||
      this.retryCallbackInFlight ||
      this.startupExhausted
    );
  }

  isManualRecoveryPause(): boolean {
    return manualRecoveryPause({
      cooldownActive: this.cooldownTimer !== null,
      fallbackPending: this.fallbackPending,
      retryCallbackInFlight: this.retryCallbackInFlight,
      startupExhausted: this.startupExhausted,
      billingPauseSurfaced: this.billingPauseSurfaced,
    });
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
