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
 * One query stays open across turns (streaming-input mode), so an enqueued user
 * message becomes the next turn. Flow:
 *   1. A prompt-too-long result lands while `idle` → inject `/compact` at the
 *      HEAD of the queue, advance to `awaiting_compact`.
 *   2. The compacted turn's result lands:
 *        - success → inject the continue nag, advance to `awaiting_resume`;
 *        - overflow OR a non-overflow error → re-compact (a non-overflow error
 *          means compaction did not produce a usable context), bounded by
 *          MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS.
 *   3. The resumed turn's result lands:
 *        - success → recovery complete, reset;
 *        - overflow OR error → re-compact (attempts preserved across the resume).
 *
 * `/compact` is enqueued at the head so it runs before any user message already
 * queued during the overflow turn, and before `finishTurn()`'s deferred-message
 * replay on the Kimi `blocking_limit` (`subtype: 'success'`) form. Detection and
 * the attempt cap are shared with the space path via
 * `space/runtime/prompt-too-long-recovery.ts`; the resume nag is chat-specific
 * (the space nag references workflow tools chat sessions do not have).
 */

import { generateUUID } from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import type { Database } from '../../storage/database';
import { Logger } from '../logger';
import {
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
  isPromptTooLongErrorMessage,
} from '../space/runtime/prompt-too-long-recovery';
import type { MessageQueue } from './message-queue';

export interface PromptTooLongSessionRecoveryContext {
  readonly sessionId: string;
  readonly db: Database;
  readonly messageQueue: MessageQueue;
}

type RecoveryPhase = 'idle' | 'awaiting_compact' | 'awaiting_resume';

/**
 * Resume notice for a regular (non-space) chat session after auto-compaction.
 * Intentionally distinct from the space-runtime nag
 * (`buildPromptTooLongContinueNag`): chat sessions have no workflow/task tools,
 * so this avoids steering the model toward nonexistent tooling and simply asks
 * it to continue or answer the user.
 */
function buildChatContinueNag(): string {
  return [
    '[Runtime recovery notice]',
    '',
    'Your conversation context exceeded the model window and was automatically compacted.',
    "The context has been reduced. Please continue what you were doing, or answer the user's last message from the current state.",
  ].join('\n');
}

/** A non-overflow SUCCESS result — the only outcome that proves compaction/resume worked. */
function isSuccessfulResult(message: SDKMessage): boolean {
  if ((message as { type?: string }).type !== 'result') return false;
  return (message as { is_error?: boolean }).is_error !== true;
}

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
   * compacted/resumed results that follow it. No-ops on ordinary results when
   * no recovery is active.
   *
   * Only a non-overflow SUCCESS result is treated as productive. A non-overflow
   * ERROR result after `/compact` (auth/rate-limit/model failure) means no
   * compacted context was produced, so the driver re-compacts (bounded) rather
   * than resuming into an unchanged, still-over-limit context — matching the
   * space-runtime path.
   */
  handleResultMessage(message: SDKMessage): void {
    const overflowed = isPromptTooLongErrorMessage(message);
    const success = isSuccessfulResult(message);

    if (this.phase === 'idle') {
      if (overflowed) {
        this.injectCompact('overflow');
      }
      return;
    }

    if (this.phase === 'awaiting_compact') {
      if (success) {
        this.injectContinueNag();
      } else {
        // Overflow again, or a non-overflow error → compaction did not yield a usable context.
        this.injectCompact(overflowed ? 'overflow-after-compact' : 'compact-error');
      }
      return;
    }

    // awaiting_resume: the resumed turn produced a result.
    if (success) {
      this.logger.warn('Prompt-too-long recovery complete; resuming normal operation.');
      this.reset();
    } else {
      this.injectCompact(overflowed ? 'overflow-after-resume' : 'resume-error');
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
    // Prepend so /compact is the very next turn — ahead of any user message
    // queued during the overflow turn and ahead of finishTurn()'s deferred
    // replay on the Kimi blocking_limit (subtype:'success') form.
    if (!this.injectMessage('/compact', true)) {
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
    if (!this.injectMessage(buildChatContinueNag(), false)) {
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
   * interrupt — or the 30s timeout fires) marks the persisted row `'failed'` so
   * `sendEnqueuedMessagesOnTurnEnd` cannot replay it on the next query, and
   * aborts the in-flight recovery so a stale phase cannot inject a stray nag.
   */
  private injectMessage(text: string, atHead: boolean): boolean {
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
    let dbId: string;
    try {
      dbId = db.saveUserMessage(sessionId, userMessage, 'enqueued', 'system');
    } catch (err) {
      this.logger.warn(
        `Failed to persist recovery message: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    void messageQueue.enqueueWithId(messageId, text, false, atHead).catch((err) => {
      this.logger.warn(
        `Recovery message ${messageId} was not consumed (queue cleared/stopped or timed ` +
          `out); aborting in-flight recovery: ${err instanceof Error ? err.message : String(err)}`
      );
      // Mark the persisted row failed so it is not replayed on the next query.
      try {
        db.updateMessageStatus([dbId], 'failed');
      } catch (markErr) {
        this.logger.warn(
          `Failed to mark aborted recovery message ${messageId} as failed: ` +
            `${markErr instanceof Error ? markErr.message : String(markErr)}`
        );
      }
      this.reset();
    });
    return true;
  }
}
