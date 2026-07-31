/**
 * RateLimitWatchdog - Auto-recovery after 429 rate/usage-limit exhaustion.
 *
 * Two-phase recovery strategy:
 *
 *  Phase A (fallback chain): when a 429/usage-limit exhausts the SDK's own
 *  retries, resolve the configured fallback chain (`GlobalSettings.modelFallbackMap`
 *  override, else `fallbackModels`) and immediately switch the session to the
 *  next untried, available entry via the existing model-switch machinery, then
 *  retry. Fallback switches are FREE — they don't count toward maxAutoRetries —
 *  and each is tracked per-episode so a 429 on the fallback advances to the
 *  next entry instead of retrying the same model.
 *
 *  Phase B (cooldown): only when the chain is exhausted (or empty) does the
 *  watchdog schedule a timed retry. The delay is computed format-agnostically:
 *  a reset timestamp parsed from the error text (ISO-8601, YYYY-MM-DD HH:mm:ss,
 *  or epoch) wins; otherwise an exponential backoff ladder (10m→30m→1h→2h→4h,
 *  cap 8h, with jitter). Waits against a known reset do NOT count toward
 *  maxAutoRetries — only speculative backoff steps do.
 *
 * Pure recovery logic lives in `fallback-recovery.ts`; this class is the
 * stateful orchestrator that owns the episode (tried entries, cooldown timer)
 * and delegates model switching + event surfacing to injected deps.
 */

import type { FallbackModelEntry, MessageContent } from '@hyperneo/shared';
import type { ProcessingStateManager } from './processing-state-manager';
import {
  classifyLimitKind,
  computeCooldown,
  entryKey,
  selectNextFallback,
  type CooldownDecision,
} from './fallback-recovery';
import { Logger } from '../logger';

export interface RateLimitWatchdogConfig {
  /**
   * Fallback cooldown used only if cooldown computation is bypassed defensively.
   * Normal cooldowns are driven by `computeCooldown` (parsed reset or backoff
   * ladder). Kept for backward compatibility and as a last-resort default.
   */
  cooldownMs: number;
  /** Maximum number of (non-free) cooldown steps before giving up entirely. */
  maxAutoRetries: number;
}

const DEFAULT_CONFIG: RateLimitWatchdogConfig = {
  cooldownMs: 10 * 60 * 1000, // 10 minutes
  maxAutoRetries: 3,
};

export type RateLimitWatchdogStatus = 'idle' | 'cooldown' | 'fallback-pending';

export interface RateLimitWatchdogState {
  status: RateLimitWatchdogStatus;
  /** Number of non-free cooldown steps used this episode. */
  retryCount: number;
  maxRetries: number;
  retryAt: number | null;
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null;
  /** provider/model keys attempted this episode (for UI/diagnostics). */
  triedEntries: string[];
  /** Resolved fallback chain in effect, or null if not applicable/resolved. */
  fallbackChain: FallbackModelEntry[] | null;
  /** True briefly while an immediate fallback switch is in flight. */
  fallbackPending: boolean;
  /** Classified limit kind for the active cooldown (for UI). */
  limitKind: 'rate_limit' | 'usage_limit' | null;
}

/**
 * Payload emitted via `notifyPause` so listeners (e.g. the Space runtime) can
 * surface a paused task status with a resume-at timestamp.
 */
export interface RateLimitPausePayload {
  kind: 'rate_limit' | 'usage_limit';
  /** Epoch-ms when the limit is expected to reset (if known). */
  resetAt?: number;
  /** Short human-readable reason (the cooldown decision reason). */
  reason: string;
}

/**
 * Dependencies injected by AgentSession. Kept as an interface so tests inject
 * fakes without a DB or live session. All members are optional except the model
 * + chain resolvers the watchdog needs to function.
 */
export interface RateLimitWatchdogDeps {
  /** Returns the currently-configured (provider, model) — the failing one. */
  getCurrentModel(): { provider: string; model: string };
  /** Returns the resolved fallback chain for the current (provider, model). */
  resolveChain(): FallbackModelEntry[];
  /**
   * Returns true iff the entry's provider is registered AND authenticated.
   * The implementation may perform async checks; the watchdog awaits them.
   */
  isEntryAvailable(entry: FallbackModelEntry): Promise<boolean>;
  /**
   * Switch the session to the entry AND re-enqueue the last user message.
   * MUST await the failed query's completion before switching (the AgentSession
   * implementation handles this). Returns false if the switch itself failed so
   * the watchdog can advance to the next entry.
   */
  switchAndRetry(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry
  ): Promise<boolean>;
  /** Surface a paused state (Space runtime marks the task rate/usage-limited). */
  notifyPause?(payload: RateLimitPausePayload): void;
  /** Surface that the pause is over (task restored to in_progress). */
  notifyResume?(): void;
}

/**
 * Callback type for when recovery fires a retry. The implementor (AgentSession)
 * re-enqueues the message and restarts the query. When `switchTo` is set, the
 * callback switches to that model first (used when a cooldown scheduled after a
 * fallback switch needs to re-switch — rare).
 */
export type RateLimitRetryCallback = (
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
  switchTo?: FallbackModelEntry
) => Promise<void>;

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

  // Episode state.
  private triedKeys = new Set<string>();
  private chain: FallbackModelEntry[] | null = null;
  private fallbackPending = false;
  private limitKind: 'rate_limit' | 'usage_limit' | null = null;
  private paused = false;
  /**
   * Monotonic episode counter. Bumped by cancel()/reset(). An in-flight
   * `fireImmediateFallback` captures the generation before awaiting teardown;
   * if cancel()/reset() fires while it's suspended (user sent a new message,
   * session reset), the generation no longer matches and the fallback aborts
   * BEFORE switching the provider or re-enqueueing the stale message.
   */
  private generation = 0;

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

  /** Set the callback invoked when a cooldown elapses (or Retry Now is pressed). */
  setRetryCallback(callback: RateLimitRetryCallback): void {
    this.retryCallback = callback;
  }

  /** Get current watchdog state (for serialization / UI). */
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

  /**
   * React to a 429/usage-limit exhaustion.
   *
   * Phase A: switch to the next untried fallback entry and retry immediately
   * (free — no retryCount bump). Phase B: when the chain is exhausted, schedule
   * a cooldown computed from a parsed reset time or the backoff ladder.
   *
   * @returns true if recovery was engaged (caller skips the terminal error
   *   broadcast), false if recovery is impossible (no message, or budget
   *   exhausted).
   */
  async scheduleRetry(
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
  ): Promise<boolean> {
    // Cancel any existing timer (a previous cooldown or in-flight switch path).
    this.cancelCooldownTimer();
    this.lastErrorMessage = errorMessage;

    // Cannot retry without a message to re-enqueue — fail fast.
    if (!lastUserMessage) {
      this.logger.warn('Cannot schedule rate limit recovery: no user message to retry.');
      return false;
    }
    this.lastUserMessage = lastUserMessage;

    // Mark the CURRENT (failed) provider+model as tried so we never re-select it.
    const { provider, model } = this.deps.getCurrentModel();
    this.triedKeys.add(entryKey({ provider, model }));

    // Resolve the chain once per episode.
    if (this.chain === null) {
      this.chain = this.deps.resolveChain();
    }

    // ── Phase A: try an immediate fallback switch (free retry). ────────────
    if (this.chain.length > 0) {
      const availability = new Map<FallbackModelEntry, boolean>();
      await Promise.all(
        this.chain.map(async (entry) => {
          availability.set(entry, await this.deps.isEntryAvailable(entry));
        })
      );
      const sel = selectNextFallback(
        this.chain,
        this.triedKeys,
        (e) => availability.get(e) === true
      );

      if (sel.next) {
        this.logger.info(
          `Fallback: switching to ${sel.next.provider}/${sel.next.model} ` +
            `(skipReason for prior candidates: ${sel.skipReason}).`
        );
        this.fallbackPending = true;
        // Fire-and-forget the switch; scheduleRetry must resolve to true (it is
        // awaited at query-runner.ts) so the caller skips the terminal error
        // broadcast + setIdle. The switch itself runs after the failed query's
        // finally via switchAndRetry's `await queryPromise`. Capture the episode
        // generation so a cancel()/reset() during the switch can abort it.
        void this.fireImmediateFallback(lastUserMessage, sel.next, this.generation);
        return true;
      }
      this.logger.info(
        `Fallback chain exhausted (${sel.skipReason}); falling through to cooldown.`
      );
    }

    // ── Phase B: chain exhausted (or empty) — schedule a cooldown. ─────────
    const decision = computeCooldown(errorMessage, this.retryCount);

    // Only speculative backoff steps count toward the budget; parsed-reset
    // waits are free (we know when the window lifts).
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

    await this.scheduleCooldown(errorMessage, decision);
    return true;
  }

  /**
   * Schedule (and notify) a cooldown wait. Extracted so the re-entry path on a
   * failed immediate switch can reuse it without re-running Phase A.
   */
  private async scheduleCooldown(errorMessage: string, decision: CooldownDecision): Promise<void> {
    const kind = classifyLimitKind(errorMessage, decision);
    this.limitKind = kind;

    const retryAt = decision.retryAtMs;
    this.logger.info(
      `Scheduling cooldown (${decision.reason}, kind=${kind}) in ${decision.delayMs}ms. ` +
        `Error: ${errorMessage}`
    );

    // Flip the processing state FIRST, then surface the pause via the bus. This
    // avoids a brief window where a subscriber reacting to the pause event
    // observes the prior (idle/processing) state (and an onIdleCallback firing).
    await this.stateManager.setRateLimitCooldown({
      retryCount: this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
    });

    // Surface the paused state before arming the timer so listeners can mark
    // the task rate/usage-limited with a resume-at timestamp. Always pass the
    // cooldown decision's actual retryAtMs — including for backoff-ladder waits
    // (the reset is unknown, but the persisted value is the honest next-retry
    // time the cross-restart sweep should trust, not an arbitrary fixed delay).
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
      // The pause is over — notify before the retry restarts the query.
      this.notifyResume();
      if (this.retryCallback) {
        void this.retryCallback(this.lastUserMessage, undefined);
      }
    }, decision.delayMs);

    if (
      this.cooldownTimer &&
      typeof this.cooldownTimer === 'object' &&
      'unref' in this.cooldownTimer
    ) {
      this.cooldownTimer.unref();
    }
  }

  /**
   * Fire an immediate fallback switch. On switch failure (or any thrown error),
   * mark the entry tried and re-enter scheduleRetry to try the next entry or
   * fall through to a cooldown (retry count NOT incremented for the failed
   * switch). Wrapped in try/catch so a rejection can never leave
   * `fallbackPending` stuck true (which would freeze getState/retryNow).
   *
   * `episodeGeneration` is captured by the caller before this is fired. If
   * cancel()/reset() runs while the switch is suspended (user sent a new
   * message, session reset), the generation no longer matches and we abort —
   * but the switch may have already begun inside `switchAndRetry`, so we let
   * it finish and then skip the re-enqueue (the stale message must not be
   * replayed alongside the user's new work).
   */
  private async fireImmediateFallback(
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null,
    entry: FallbackModelEntry,
    episodeGeneration: number
  ): Promise<void> {
    // Aborted before we even started? Don't touch the session at all.
    if (episodeGeneration !== this.generation) {
      this.logger.info('Immediate fallback aborted before start (episode superseded).');
      this.fallbackPending = false;
      return;
    }

    let ok = false;
    try {
      ok = await this.deps.switchAndRetry(lastUserMessage, entry);
    } catch (err) {
      this.logger.error(
        `Fallback switch to ${entry.provider}/${entry.model} threw; advancing to next entry:`,
        err
      );
      ok = false;
    } finally {
      this.fallbackPending = false;
    }

    // The switch may have started while we were suspended. If the episode was
    // superseded (cancel/reset) during the switch, do NOT advance the chain or
    // re-enqueue — the new episode owns the session now.
    if (episodeGeneration !== this.generation) {
      this.logger.info(
        'Immediate fallback superseded mid-switch (cancel/reset); skipping chain advance + re-enqueue.'
      );
      return;
    }

    if (ok) {
      return;
    }
    this.triedKeys.add(entryKey(entry));
    // Re-enter recovery with the same error/message to try the next entry or
    // schedule a cooldown. Guard against losing the message and against a
    // rejecting re-entry (which would otherwise escape unhandled).
    if (this.lastUserMessage) {
      try {
        await this.scheduleRetry(this.lastErrorMessage, this.lastUserMessage);
      } catch (err) {
        // scheduleRetry schedules a cooldown or another switch; if it rejects
        // (e.g. setRateLimitCooldown's DB write), fall back to a single
        // best-effort cooldown so recovery isn't silently lost.
        this.logger.error('Fallback re-entry rejected; scheduling a deferrive cooldown:', err);
        try {
          await this.scheduleCooldown(
            this.lastErrorMessage,
            computeCooldown(this.lastErrorMessage, this.retryCount)
          );
        } catch {
          // Nothing more we can do; the caller (query-runner) will surface the
          // original 429 via its normal error path on the next message.
        }
      }
    }
  }

  /**
   * Cancel any pending cooldown timer. Called on new user input, explicit
   * cancel, reset, or cleanup. Notifies resume so a paused task is restored.
   * Bumps the episode generation so any in-flight immediate fallback switch
   * aborts before it can switch the provider or re-enqueue the stale message.
   */
  cancel(): void {
    this.generation++;
    this.cancelCooldownTimer();
    this.fallbackPending = false;
    this.notifyResume();
  }

  private cancelCooldownTimer(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.logger.info('Cancelled pending rate limit cooldown.');
    }
  }

  /**
   * Immediately trigger the cooldown retry (bypassing the wait). Used when the
   * user clicks "Retry Now". Returns false if no cooldown is pending or a
   * fallback switch is in flight (the switch should be allowed to complete).
   */
  retryNow(): boolean {
    if (this.fallbackPending || this.cooldownTimer === null) {
      return false;
    }

    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;

    this.logger.info(
      `Immediate retry triggered (step ${this.retryCount}/${this.config.maxAutoRetries}).`
    );
    this.notifyResume();
    if (this.retryCallback) {
      void this.retryCallback(this.lastUserMessage, undefined);
    }
    return true;
  }

  /**
   * Reset the watchdog entirely (e.g. on a successful API call). Clears the
   * episode so the next 429 starts a fresh fallback chain.
   */
  reset(): void {
    this.cancel();
    this.retryCount = 0;
    this.lastUserMessage = null;
    this.lastErrorMessage = '';
    this.triedKeys.clear();
    this.chain = null;
    this.limitKind = null;
  }

  /** Remaining ms until the cooldown fires (0 if none scheduled). */
  private getRemainingMs(): number {
    const state = this.stateManager.getState();
    if (state.status === 'rate_limit_cooldown') {
      return Math.max(0, state.retryAt - Date.now());
    }
    return 0;
  }

  /** Is a cooldown auto-retry currently scheduled? */
  isPending(): boolean {
    return this.cooldownTimer !== null;
  }

  private notifyPause(payload: RateLimitPausePayload): void {
    this.paused = true;
    try {
      this.deps.notifyPause?.(payload);
    } catch (err) {
      this.logger.warn('notifyPause callback threw:', err);
    }
  }

  private notifyResume(): void {
    if (!this.paused) return;
    this.paused = false;
    try {
      this.deps.notifyResume?.();
    } catch (err) {
      this.logger.warn('notifyResume callback threw:', err);
    }
  }

  /** Cleanup (called during session cleanup). */
  destroy(): void {
    this.cancel();
    this.retryCallback = null;
  }
}
