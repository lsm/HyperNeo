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

/**
 * Bounded retry when a cooldown fires but the replacement query can't start
 * (SDK startup / session-resume validation failure). Short fixed delay, capped
 * so a persistent startup failure can't loop forever. Does NOT consume the main
 * maxAutoRetries budget (that's for genuine rate-limit backoff).
 */
const STARTUP_RETRY_DELAY_MS = 60 * 1000; // 60s
const MAX_STARTUP_RETRIES = 3;

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
  /**
   * Returns the resolved fallback chain for the current (provider, model).
   * The implementation canonicalizes the current model before the
   * modelFallbackMap lookup so an alias-configured session matches its
   * model-specific override.
   */
  resolveChain(): Promise<FallbackModelEntry[]>;
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
    entry: FallbackModelEntry,
    episodeGeneration: number
  ): Promise<boolean>;
  /**
   * Optional: resolve a (provider, model) to its canonical model ID so the
   * tried-entry set can dedupe an alias (e.g. `sonnet`) against a canonical
   * fallback entry. Defaults to the raw model ID when unset. Must be
   * provider-aware (the same alias can resolve differently per provider).
   */
  resolveModelId?(provider: string, model: string): Promise<string>;
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
  /** Bounded startup-retry counter (query failed to start after a cooldown). */
  private startupRetries = 0;
  /**
   * True when startup retries were exhausted and the auto-retry timer was
   * dropped (the task stays paused). `retryNow` admits a manual Retry Now /
   * Resume because of this flag, so the parked task is recoverable in-process
   * (not just via a daemon restart). Cleared on cancel/reset/new episode/a
   * successful start.
   */
  private startupExhausted = false;
  /**
   * The user-message UUID the current episode is tracking. A genuinely new
   * user turn (different UUID) starts a fresh episode — clears triedKeys,
   * chain, retryCount — so a new request that 429s gets the full fallback
   * chain and budget instead of reusing the prior turn's exhausted state.
   * Recovery re-enqueues the SAME UUID, so the episode is preserved.
   */
  private episodeMessageUuid: string | null = null;

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
    // Capture the episode generation BEFORE the first await. A cancel()/reset()
    // during the model-ID / chain / availability resolution below bumps the
    // generation; capturing it here and re-checking before any side effect means
    // an interrupt/reset that arrived mid-resolution can't let a stale fallback
    // switch or cooldown slip through — the captured baseline no longer matches.
    const entryGeneration = this.generation;

    // Cancel any existing timer (a previous cooldown or in-flight switch path).
    this.cancelCooldownTimer();
    this.lastErrorMessage = errorMessage;

    // Cannot retry without a message to re-enqueue — fail fast.
    if (!lastUserMessage) {
      this.logger.warn('Cannot schedule rate limit recovery: no user message to retry.');
      return false;
    }
    this.lastUserMessage = lastUserMessage;

    // A genuinely new user turn (different UUID from the episode we're tracking)
    // starts a fresh episode: clear the tried-set, resolved chain, and cooldown
    // budget so the new request gets the full fallback chain. Recovery
    // re-enqueues the SAME UUID, so this is a no-op there and the episode
    // (including which fallbacks were already tried) is preserved. The
    // startup-retry budget resets too, so a replacement turn doesn't inherit the
    // prior turn's failed-startup count and exhaust prematurely.
    if (this.episodeMessageUuid !== lastUserMessage.uuid) {
      this.episodeMessageUuid = lastUserMessage.uuid;
      this.triedKeys.clear();
      this.chain = null;
      this.retryCount = 0;
      this.startupRetries = 0;
      this.startupExhausted = false;
    }

    // Mark the CURRENT (failed) provider+model as tried so we never re-select it.
    // Key by the canonical model ID when a resolver is available so an alias
    // (e.g. `sonnet`) and a canonical fallback entry for the same model dedupe.
    const { provider, model } = this.deps.getCurrentModel();
    const currentCanonical = (await this.deps.resolveModelId?.(provider, model)) ?? model;
    this.triedKeys.add(`${provider}/${currentCanonical}`);

    // Resolve the chain once per episode.
    if (this.chain === null) {
      this.chain = await this.deps.resolveChain();
    }

    // ── Phase A: try an immediate fallback switch (free retry). ────────────
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
        // If cancel()/reset() landed during the resolution awaits above, bail
        // before switching providers or re-enqueueing — the new episode owns the
        // session now. Return true so the caller still skips the terminal 429
        // broadcast (the cancel/interrupt handles teardown).
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
        // Fire-and-forget the switch; scheduleRetry must resolve to true (it is
        // awaited at query-runner.ts) so the caller skips the terminal error
        // broadcast + setIdle. The switch itself runs after the failed query's
        // finally via switchAndRetry's `await queryPromise`. Pass the ENTRY
        // generation (not this.generation, which a mid-resolution cancel already
        // bumped) so fireImmediateFallback's own guard catches a cancel/reset
        // during the switch.
        void this.fireImmediateFallback(lastUserMessage, sel.next, entryGeneration);
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

    // Same superseded-episode guard as the fallback branch above: don't arm a
    // cooldown (or publish a pause) for an episode cancelled/reset during
    // resolution.
    if (entryGeneration !== this.generation) {
      this.logger.info(
        'Cooldown resolution completed but episode was superseded; aborting schedule.'
      );
      return true;
    }

    await this.scheduleCooldown(errorMessage, decision, entryGeneration);
    return true;
  }

  /**
   * Schedule (and notify) a cooldown wait. Extracted so the re-entry path on a
   * failed immediate switch can reuse it without re-running Phase A.
   */
  private async scheduleCooldown(
    errorMessage: string,
    decision: CooldownDecision,
    episodeGeneration: number
  ): Promise<void> {
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

    // A cancel()/reset() during the setRateLimitCooldown await bumped the
    // generation. At that moment the timer is still null and the pause is
    // unpublished, so cancel had nothing to undo — committing notifyPause + the
    // timer now would pause and arm a cooldown for a dead episode. Abort.
    if (episodeGeneration !== this.generation) {
      this.logger.info(
        'Episode superseded during cooldown state write; not publishing pause or arming.'
      );
      return;
    }

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
      // Fire the retry and only notify resume once it actually started. If the
      // retry can't start (e.g. SDK startup / resume validation fails), restoring
      // the task + clearing the restriction up-front would orphan the consumed
      // message with no cooldown or terminal error to re-drive it. On failure,
      // reschedule a short cooldown so recovery retries instead of going silent.
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

  /**
   * Fire the cooldown retry. Notifies resume (clearing the paused task status)
   * only after the retry actually started; if the retry can't start, reschedule
   * a short cooldown so recovery retries instead of orphaning the consumed
   * message with no pause or terminal error to re-drive it.
   */
  private async fireCooldownRetry(errorMessage: string): Promise<void> {
    // Capture the generation at entry. A cancel()/reset() during the awaited
    // retry callback bumps it; if it changed, the episode was superseded and we
    // must NOT notify resume, re-enqueue, or re-arm — the cancel owns teardown.
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
    // Superseded mid-callback: stop. Don't notify resume (the cancel did) and
    // don't re-arm (the episode is dead).
    if (entryGeneration !== this.generation) {
      this.logger.info('Cooldown retry completed but episode was superseded; aborting.');
      return;
    }
    if (started) {
      // The query started — reset the startup-retry budget and clear the pause.
      this.startupRetries = 0;
      this.startupExhausted = false;
      this.notifyResume();
      return;
    }

    // Retry didn't start (e.g. SDK startup / session-resume validation failed).
    // Bounded startup-retry at a short fixed delay — does NOT touch the main
    // cooldown retryCount/maxAutoRetries budget (that's for genuine rate-limit
    // backoff). Give up after MAX_STARTUP_RETRIES so we can't loop forever.
    this.startupRetries += 1;
    if (this.startupRetries > MAX_STARTUP_RETRIES) {
      // The query never started, so do NOT notifyResume: that would clear the
      // restriction and restore the task to in_progress (falsely signalling
      // active work) while the session sits idle. isAgentSessionAlive() treats
      // that idle state as alive, so the runtime tick would not respawn it and
      // the consumed turn would be orphaned. Instead keep the task paused
      // (rate/usage-limited) and park without an auto-retry timer, setting
      // startupExhausted so a manual Retry Now / Resume (retryNow) can still
      // drive recovery in-process (otherwise the in-memory session is skipped
      // by the cross-restart sweep and the task would be stuck until restart).
      // recoverRateLimitedTasks + the persisted restrictions.resetAt cover
      // restart / dead-session recovery.
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
    // The failed retry callback left the session `idle`. Re-establish the
    // rate_limit_cooldown processing state so the pause is honored during the
    // startup-retry delay (injectMessageIntoSession's cooldown deferral gate
    // keys off it) and idle observers don't read a false completion.
    try {
      await this.stateManager.setRateLimitCooldown({
        retryCount: this.retryCount,
        maxRetries: this.config.maxAutoRetries,
        retryAt: Date.now() + STARTUP_RETRY_DELAY_MS,
      });
    } catch (err) {
      this.logger.warn('Failed to restore rate_limit_cooldown before startup retry:', err);
    }
    // A replacement message / Interrupt during the setRateLimitCooldown await
    // bumped the generation; clearPendingCooldown()/cancel() saw no timer to
    // clear, so don't arm a stale timer that would later retry the old message
    // into the replacement query. (Mirrors the scheduleCooldown guard.)
    if (entryGeneration !== this.generation) {
      this.logger.info(
        'Startup retry aborted after state write (episode superseded); not re-arming.'
      );
      return;
    }
    // Re-arm a short timer that re-fires this method (keeps the task paused;
    // does not re-resolve the chain or consume the main budget).
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
    // Mark this entry tried using its canonical key (consistent with the
    // selection keying above) so an alias-vs-canonical repeat can't loop.
    const canonical =
      (await this.deps.resolveModelId?.(entry.provider, entry.model)) ?? entry.model;
    this.triedKeys.add(`${entry.provider}/${canonical}`);
    // Re-enter recovery with the same error/message to try the next entry or
    // schedule a cooldown. Guard against losing the message and against a
    // rejecting re-entry (which would otherwise escape unhandled).
    if (this.lastUserMessage) {
      try {
        const scheduled = await this.scheduleRetry(this.lastErrorMessage, this.lastUserMessage);
        if (!scheduled) {
          // Re-entry returned false — e.g. a fallback that became available
          // only after the cooldown budget was spent was selected, then the
          // max-budget check tripped on re-entry. scheduleRetry already returned
          // true to the ORIGINAL caller (suppressing the terminal 429), so
          // without a cooldown here the consumed turn would sit idle with no
          // recovery driver. Schedule a deferrive cooldown so it's re-driven.
          this.logger.warn(
            'Fallback re-entry returned false (budget exhausted); scheduling a deferrive cooldown.'
          );
          await this.scheduleCooldown(
            this.lastErrorMessage,
            computeCooldown(this.lastErrorMessage, this.retryCount),
            episodeGeneration
          );
        }
      } catch (err) {
        // scheduleRetry schedules a cooldown or another switch; if it rejects
        // (e.g. setRateLimitCooldown's DB write), fall back to a single
        // best-effort cooldown so recovery isn't silently lost.
        this.logger.error('Fallback re-entry rejected; scheduling a deferrive cooldown:', err);
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

  /**
   * Cancel any pending cooldown timer. Called on explicit reset/interrupt
   * (resetQuery, hard reset, cleanup). Notifies resume so a paused task is
   * restored. Bumps the episode generation so any in-flight immediate fallback
   * switch aborts before it can switch the provider or re-enqueue the stale
   * message. Also clears the episode so a subsequent turn starts fresh.
   *
   * NOTE: recovery re-enqueues (fallback switch retry, cooldown fire) must use
   * `clearPendingCooldown()` instead — they must NOT bump the generation (or an
   * in-flight fallback self-aborts) and must preserve the episode.
   */
  cancel(notifyResume = true): void {
    this.generation++;
    this.cancelCooldownTimer();
    this.fallbackPending = false;
    this.startupExhausted = false;
    this.episodeMessageUuid = null;
    // Drop the stale message too: the fireImmediateFallback re-entry path gates
    // on `if (this.lastUserMessage)`, and a re-entry reached after this cancel
    // would otherwise re-arm recovery (scheduleRetry captures the bumped
    // generation as a fresh baseline) for the message the user just stopped.
    this.lastUserMessage = null;
    // Notify resume so a paused task is restored to in_progress — UNLESS the
    // caller is an explicit "stop the auto-retry" action (the cooldown banner's
    // Cancel via cancelRateLimitRetry). There, resuming would falsely signal
    // active work and the ensuing idle transition can be misread as successful
    // node completion, advancing the workflow past a failed turn. The banner
    // path passes notifyResume=false so the task stays paused/blocked.
    if (notifyResume) {
      this.notifyResume();
    }
  }

  /**
   * Clear only the pending cooldown timer (and the fallback-pending flag),
   * WITHOUT bumping the episode generation or clearing the episode. Used before
   * an internal recovery re-enqueue (e.g. startQueryAndEnqueue from
   * executeRateLimitAutoRetry) so a stale timer doesn't fire into the new query
   * while the in-flight fallback and the per-episode tried-set are preserved.
   */
  clearPendingCooldown(): void {
    this.cancelCooldownTimer();
    this.fallbackPending = false;
  }

  /**
   * True when `generation` no longer matches the active episode — i.e. a
   * cancel()/reset() landed after `generation` was captured. Recovery callbacks
   * and sub-methods (switchAndRetryForFallback, executeRateLimitAutoRetry,
   * scheduleCooldown) re-check this immediately before any session-mutating side
   * effect (model switch, re-enqueue, pause publish, timer arm) so a cancel that
   * arrives during an internal await can't let the stale side effect commit and
   * replay the stopped turn.
   */
  isSuperseded(generation: number): boolean {
    return generation !== this.generation;
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
   * user clicks "Retry Now" (or `resumeRateLimitedSubSession` for a manual
   * Resume). Returns false if no cooldown is pending or a fallback switch is in
   * flight (the switch should be allowed to complete).
   *
   * The actual retry is delegated to `fireCooldownRetry` so the manual path
   * matches the auto path: notify resume ONLY after the query actually starts,
   * and reschedule a short cooldown if it fails (otherwise a failed manual
   * retry would restore the task to in_progress with no query running —
   * stuck/idle).
   */
  retryNow(): boolean {
    // Admit a manual retry when a cooldown timer is pending OR when startup
    // retries were exhausted (the task is parked-paused with no timer). Without
    // the exhausted branch, manual Resume would get `false` and — since the
    // in-memory session is skipped by the cross-restart sweep — the task would
    // be stuck until a daemon restart.
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
    // Manual resume from the parked (startup-exhausted) state gets a fresh
    // startup-retry budget so the user's explicit retry can re-engage recovery.
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

  /**
   * Reset the watchdog entirely (e.g. on a successful API call). Clears the
   * episode so the next 429 starts a fresh fallback chain.
   */
  reset(): void {
    this.cancel();
    this.retryCount = 0;
    this.startupRetries = 0;
    this.startupExhausted = false;
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
