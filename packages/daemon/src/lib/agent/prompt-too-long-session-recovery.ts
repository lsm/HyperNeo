/**
 * Prompt-too-long recovery driver for the general (non-space) session path.
 *
 * The space runtime recovers context overflow ("prompt is too long") for its own
 * worker/node sessions via an idle sweep
 * (`SpaceRuntime.recoverPromptTooLongIdleExecution`). Regular chat sessions have
 * no such sweep, so a Kimi/Anthropic prompt-too-long RESULT simply ends the turn
 * and leaves the session idle on an exhausted context — the user must manually
 * `/compact`. This driver gives those sessions the same compact-then-continue
 * recovery, driven by the discrete SDK result stream instead of a sweep.
 *
 * One query stays open across turns, so an enqueued user message becomes the
 * next turn. Flow:
 *   1. A prompt-too-long result lands while `idle` → inject `/compact`, advance
 *      to `awaiting_compact`.
 *   2. The compacted turn's result lands:
 *        - still overflow → re-compact (bounded by MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS);
 *        - otherwise → inject the "continue your work" nag, advance to `awaiting_resume`.
 *   3. The resumed turn's result lands:
 *        - overflow → re-compact (attempts preserved across the resume);
 *        - otherwise → recovery complete, reset.
 *
 * Detection, the nag text, and the attempt cap are shared with the space path
 * via `space/runtime/prompt-too-long-recovery.ts` so the two paths stay
 * consistent. Only the driver loop is specific to the general session.
 */

import { generateUUID } from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';
import {
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
  buildPromptTooLongContinueNag,
  isPromptTooLongErrorMessage,
} from '../space/runtime/prompt-too-long-recovery';
import type { MessageQueue } from './message-queue';

export interface PromptTooLongSessionRecoveryContext {
  readonly sessionId: string;
  readonly db: Database;
  readonly messageQueue: MessageQueue;
}

type RecoveryPhase = 'idle' | 'awaiting_compact' | 'awaiting_resume';

export class PromptTooLongSessionRecovery {
  private phase: RecoveryPhase = 'idle';
  /** Consecutive unproductive compactions this recovery episode. Resets on completion/give-up. */
  private compactAttempts = 0;
  private readonly logger: Logger;

  constructor(private readonly ctx: PromptTooLongSessionRecoveryContext) {
    this.logger = new Logger(`PromptTooLongRecovery ${ctx.sessionId}`);
  }

  /** True while a compact/continue sequence is in flight. */
  isActive(): boolean {
    return this.phase !== 'idle';
  }

  /**
   * Drive recovery from an SDK result message. Called by SDKMessageHandler for
   * every result so the driver can react to an overflow result AND to the
   * compacted/resumed results that follow it. No-ops on non-overflow results
   * when no recovery is active.
   */
  handleResultMessage(message: SDKMessage): void {
    const overflowed = isPromptTooLongErrorMessage(message);

    if (this.phase === 'idle') {
      if (overflowed) {
        this.injectCompact('overflow');
      }
      return;
    }

    if (this.phase === 'awaiting_compact') {
      if (overflowed) {
        // Compaction could not shrink the context enough — re-compact up to the cap.
        this.injectCompact('overflow-after-compact');
      } else {
        this.injectContinueNag();
      }
      return;
    }

    // awaiting_resume: the resumed turn produced a result.
    if (overflowed) {
      this.injectCompact('overflow-after-resume');
    } else {
      // Resume made progress — recovery complete.
      this.logger.warn('Prompt-too-long recovery complete; resuming normal operation.');
      this.reset();
    }
  }

  /** Clear all recovery state (completion, give-up, or teardown). */
  reset(): void {
    this.phase = 'idle';
    this.compactAttempts = 0;
  }

  private injectCompact(reason: string): void {
    if (this.compactAttempts >= MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS) {
      this.logger.warn(
        `Prompt-too-long recovery gave up after ${this.compactAttempts} compact attempt(s) ` +
          `(${reason}); leaving the session idle for the user.`
      );
      this.reset();
      return;
    }
    this.compactAttempts += 1;
    if (!this.injectMessage('/compact')) {
      this.logger.warn(`Failed to inject /compact (${reason}); aborting recovery.`);
      this.reset();
      return;
    }
    this.phase = 'awaiting_compact';
    this.logger.warn(
      `Injected /compact for prompt-too-long recovery ` +
        `(attempt ${this.compactAttempts}/${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS}, ${reason}).`
    );
  }

  private injectContinueNag(): void {
    if (!this.injectMessage(buildPromptTooLongContinueNag())) {
      this.logger.warn('Failed to inject continue nag; aborting recovery.');
      this.reset();
      return;
    }
    this.phase = 'awaiting_resume';
    this.logger.warn('Injected continue nag after compaction.');
  }

  /**
   * Persist a synthetic user message (status 'enqueued', origin 'system') and
   * queue it for the running SDK turn. Mirrors the space-runtime
   * `injectRuntimeRecoveryMessage` path so the injected message is persisted,
   * broadcast at yield time, and acknowledged like any enqueued user message.
   *
   * The enqueue is fire-and-forget: this runs inside the SDK for-await loop, so
   * awaiting consumption would stall the loop until the next turn is pulled.
   * Returns false only when persistence fails (the message never reached the
   * queue). A consumption rejection (the queue is cleared/stopped — e.g. an
   * interrupt — or the 30s timeout fires) aborts the in-flight recovery so a
   * stale phase cannot inject a stray nag later.
   */
  private injectMessage(text: string): boolean {
    const { sessionId, db, messageQueue } = this.ctx;
    const messageId = generateUUID();
    const userMessage = {
      type: 'user' as const,
      uuid: messageId,
      session_id: sessionId,
      parent_tool_use_id: null,
      isSynthetic: true,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text }],
      },
    } as unknown as SDKUserMessage;
    try {
      db.saveUserMessage(sessionId, userMessage, 'enqueued', 'system');
    } catch (err) {
      this.logger.warn(
        `Failed to persist recovery message: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    void messageQueue.enqueueWithId(messageId, text).catch((err) => {
      this.logger.warn(
        `Recovery message ${messageId} was not consumed (queue cleared/stopped or timed ` +
          `out); aborting in-flight recovery: ${err instanceof Error ? err.message : String(err)}`
      );
      this.reset();
    });
    return true;
  }
}
