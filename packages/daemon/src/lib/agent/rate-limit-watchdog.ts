/**
 * RateLimitWatchdog - Auto-retry after 429 rate limit exhaustion
 *
 * When the Claude SDK exhausts all retries on a 429 (rate limited) error,
 * the session stalls. This watchdog detects that state and schedules an
 * automatic retry after a cooldown period.
 *
 * Behavior:
 * - Schedules a retry timer (default 10 minutes) when 429 exhaustion is detected
 * - Max 3 auto-retry cycles before giving up entirely
 * - Cancelable: if the user sends a new message, the timer is cleared
 * - Fires the retry by re-enqueueing the last user message and restarting the query
 */

import type { MessageContent } from '@neokai/shared';
import type { ProcessingStateManager } from './processing-state-manager';
import { Logger } from '../logger';

export interface RateLimitWatchdogConfig {
  /** Cooldown period in ms before auto-retry (default: 600000 = 10 min) */
  cooldownMs: number;
  /** Maximum number of auto-retry cycles (default: 3) */
  maxAutoRetries: number;
}

const DEFAULT_CONFIG: RateLimitWatchdogConfig = {
  cooldownMs: 10 * 60 * 1000, // 10 minutes
  maxAutoRetries: 3,
};

export interface RateLimitWatchdogState {
  status: 'idle' | 'cooldown';
  retryCount: number;
  maxRetries: number;
  retryAt: number | null;
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null;
}

/**
 * Callback type for when the cooldown timer fires and a retry should be attempted.
 * The implementor (AgentSession) is responsible for re-enqueueing the message
 * and restarting the query.
 */
export type RateLimitRetryCallback = (
  lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
) => Promise<void>;

export class RateLimitWatchdog {
  private logger: Logger;
  private config: RateLimitWatchdogConfig;
  private retryCount = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUserMessage: { uuid: string; content: string | MessageContent[] } | null = null;
  private retryCallback: RateLimitRetryCallback | null = null;
  private stateManager: ProcessingStateManager;

  constructor(
    sessionId: string,
    stateManager: ProcessingStateManager,
    config?: Partial<RateLimitWatchdogConfig>
  ) {
    this.logger = new Logger(`RateLimitWatchdog ${sessionId}`);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateManager = stateManager;
  }

  /**
   * Set the callback invoked when the cooldown timer fires.
   */
  setRetryCallback(callback: RateLimitRetryCallback): void {
    this.retryCallback = callback;
  }

  /**
   * Get current watchdog state (for serialization / UI).
   */
  getState(): RateLimitWatchdogState {
    const retryAt = this.cooldownTimer !== null ? Date.now() + this.getRemainingMs() : null;

    return {
      status: this.cooldownTimer !== null ? 'cooldown' : 'idle',
      retryCount: this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
      lastUserMessage: this.lastUserMessage,
    };
  }

  /**
   * Schedule an auto-retry after cooldown. Called when a 429 exhaustion error
   * is detected in QueryRunner's error handling.
   *
   * @returns true if scheduled, false if max retries exceeded
   */
  async scheduleRetry(
    errorMessage: string,
    lastUserMessage: { uuid: string; content: string | MessageContent[] } | null
  ): Promise<boolean> {
    // Cancel any existing timer
    this.cancel();

    // Cannot retry without a message to re-enqueue — fail fast instead of
    // scheduling a no-op cooldown timer that would abort on fire.
    if (!lastUserMessage) {
      this.logger.warn('Cannot schedule rate limit auto-retry: no user message to retry.');
      return false;
    }

    if (this.retryCount >= this.config.maxAutoRetries) {
      this.logger.warn(
        `Max auto-retries (${this.config.maxAutoRetries}) exceeded for 429 error. ` +
          `Giving up. Error: ${errorMessage}`
      );
      return false;
    }

    this.lastUserMessage = lastUserMessage;
    this.retryCount++;

    const retryAt = Date.now() + this.config.cooldownMs;

    this.logger.info(
      `Scheduling auto-retry #${this.retryCount}/${this.config.maxAutoRetries} ` +
        `in ${this.config.cooldownMs}ms. Error: ${errorMessage}`
    );

    // Set processing state to rate_limit_cooldown (awaited to prevent
    // race with user messages or retry-now overwriting the state).
    await this.stateManager.setRateLimitCooldown({
      retryCount: this.retryCount,
      maxRetries: this.config.maxAutoRetries,
      retryAt,
    });

    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.logger.info(
        `Cooldown elapsed for auto-retry #${this.retryCount}/${this.config.maxAutoRetries}. Firing retry.`
      );
      if (this.retryCallback) {
        void this.retryCallback(this.lastUserMessage);
      }
    }, this.config.cooldownMs);

    // Unref so the timer doesn't keep the process alive
    if (
      this.cooldownTimer &&
      typeof this.cooldownTimer === 'object' &&
      'unref' in this.cooldownTimer
    ) {
      this.cooldownTimer.unref();
    }

    return true;
  }

  /**
   * Cancel any pending auto-retry. Called when:
   * - User sends a new message before the retry fires
   * - User explicitly cancels the auto-retry
   * - Session is cleaned up
   */
  cancel(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.logger.info('Cancelled pending rate limit auto-retry.');
    }
  }

  /**
   * Immediately trigger the retry (bypassing the cooldown).
   * Used when the user clicks "Retry Now" in the UI.
   *
   * @returns true if a retry was pending and fired, false if no retry was pending
   */
  retryNow(): boolean {
    if (this.cooldownTimer === null) {
      return false;
    }

    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;

    this.logger.info(
      `Immediate retry triggered for auto-retry #${this.retryCount}/${this.config.maxAutoRetries}.`
    );

    if (this.retryCallback) {
      void this.retryCallback(this.lastUserMessage);
    }

    return true;
  }

  /**
   * Reset the watchdog entirely (e.g., on successful API call).
   */
  reset(): void {
    this.cancel();
    this.retryCount = 0;
    this.lastUserMessage = null;
  }

  /**
   * Get remaining milliseconds until the retry fires.
   * Returns 0 if no retry is scheduled.
   */
  private getRemainingMs(): number {
    // Approximation — the timer was set with config.cooldownMs,
    // so remaining time is tracked via the scheduled retryAt from the state.
    const state = this.stateManager.getState();
    if (state.status === 'rate_limit_cooldown') {
      const remaining = state.retryAt - Date.now();
      return Math.max(0, remaining);
    }
    return 0;
  }

  /**
   * Check if a cooldown auto-retry is currently scheduled.
   */
  isPending(): boolean {
    return this.cooldownTimer !== null;
  }

  /**
   * Cleanup (called during session cleanup).
   */
  destroy(): void {
    this.cancel();
    this.retryCallback = null;
  }
}
