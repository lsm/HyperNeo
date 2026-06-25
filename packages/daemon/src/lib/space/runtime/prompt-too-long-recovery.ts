/**
 * Prompt-too-long recovery helpers.
 *
 * A worker/node session that overflows its context window receives a terminal
 * SDK `result` message (`subtype: error_during_execution`,
 * `terminal_reason: 'prompt_too_long'`). The idle sweep treats any result as a
 * safe terminal point and skips it, so the execution sticks. These helpers
 * detect that signature and supply the compact-then-continue recovery messages.
 *
 * A plain "continue" on an over-long context is useless — the recovery MUST
 * compact FIRST, then continue.
 */

import type { SDKMessage } from '@neokai/shared/sdk';

/**
 * Maximum consecutive *unproductive* `/compact` attempts before escalating to
 * `blocked`. Bounds the loop when compaction cannot shrink the context enough
 * (e.g. a single message already exceeds the limit). Reset to 0 once a
 * compaction is productive (the resume nag is delivered), so a long-running
 * worker that legitimately re-fills context over time is not penalised for
 * stale recovery history.
 */
export const MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS = 2;

/**
 * Maximum time to wait for the `/compact` turn to produce a result before
 * treating the compaction as hung and escalating to `blocked`. The SDK's
 * compaction involves an LLM summarisation call, so this is generous; if no
 * result lands in this window the session is stuck (and the execution is
 * `idle`, so the alive-stuck sweep cannot rescue it).
 */
export const COMPACT_RESULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-execution recovery state. Keyed by `${runId}:${executionId}` in
 * `SpaceRuntime.promptTooLongRecovery`.
 */
export interface PromptTooLongRecoveryState {
  /**
   * Consecutive *unproductive* `/compact` attempts. Forgiven implicitly when the
   * resumed turn makes real progress (a non-overflow result clears the recovery
   * state); an immediate re-overflow leaves this in place so the cap escalates.
   */
  compactAttempts: number;
  /**
   * True after a `/compact` was successfully injected and we are waiting for the
   * compacted RESULT to land. Guards against re-injecting `/compact` while the
   * turn is in flight.
   */
  awaitingContinue: boolean;
  /**
   * dbId of the last message observed when `/compact` was injected (the
   * pre-compact result). `getLastSDKMessage` keeps returning this while the
   * enqueued `/compact` is in flight; the wait clears only when a newer consumed
   * `result` lands.
   */
  awaitingContinueAfterDbId: string | null;
  /** Timestamp (ms) the `/compact` was injected, for the wait timeout. */
  awaitingContinueSince: number | null;
  /**
   * True once compaction produced a non-overflow result and the "resume your
   * work" nag still needs to be delivered (or retried after a failed delivery).
   */
  continueNagPending: boolean;
  /** Failed resume-nag deliveries; bounded before giving up. */
  continueNagAttempts: number;
  /**
   * True after the resume nag was delivered. Like the `/compact`, the nag is an
   * enqueued user message invisible to `getLastSDKMessage`, so the sweep keeps
   * seeing the compact-success result until the resumed turn advances. This
   * marker keeps recovery entered (preventing the terminal-skip from clearing
   * the state prematurely); it clears once a message newer than
   * `awaitingResumeAfterDbId` arrives.
   */
  awaitingResume: boolean;
  /** dbId of the compact-success result that preceded the resume nag. */
  awaitingResumeAfterDbId: string | null;
}

export function createPromptTooLongRecoveryState(): PromptTooLongRecoveryState {
  return {
    compactAttempts: 0,
    awaitingContinue: false,
    awaitingContinueAfterDbId: null,
    awaitingContinueSince: null,
    continueNagPending: false,
    continueNagAttempts: 0,
    awaitingResume: false,
    awaitingResumeAfterDbId: null,
  };
}

/**
 * Detect the prompt-too-long signature on a result message.
 *
 * The SDK sets `terminal_reason: 'prompt_too_long'` on the result, and/or the
 * `errors[]` array carries the API message. We accept both, and use a lenient
 * `/prompt is too long/i` for the errors body since not every provider includes
 * the `N tokens > M maximum` form.
 */
export function isPromptTooLongResult(message: SDKMessage | null | undefined): boolean {
  if (!message) return false;
  const msg = message as {
    type?: string;
    terminal_reason?: string;
    errors?: unknown;
  };
  if (msg.type !== 'result') return false;
  if (msg.terminal_reason === 'prompt_too_long') return true;
  if (Array.isArray(msg.errors)) {
    for (const err of msg.errors) {
      if (typeof err === 'string' && /prompt is too long/i.test(err)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The "continue your work" nag injected after compaction succeeds. Only sent
 * once the last message is no longer a prompt-too-long result — i.e. the
 * context dropped back below the limit — so it never re-hits the same wall.
 */
export function buildPromptTooLongContinueNag(): string {
  return [
    '[Runtime recovery notice]',
    '',
    'Your conversation context exceeded the model window and was automatically compacted.',
    'The context has been reduced. Continue your assigned work from the current state.',
    'If work is complete, report completion through the workflow tools.',
    'If you are blocked, report the blocker clearly through the available tools. Do not wait silently.',
  ].join('\n');
}
