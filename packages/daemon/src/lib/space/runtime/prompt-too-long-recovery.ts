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
 * Maximum `/compact` attempts for a single execution before escalating to
 * `blocked`. Bounds the loop when compaction cannot shrink the context enough
 * (e.g. a single message already exceeds the limit).
 */
export const MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS = 2;

/**
 * Per-execution recovery state. Keyed by `${runId}:${executionId}` in
 * `SpaceRuntime.promptTooLongRecovery`.
 */
export interface PromptTooLongRecoveryState {
  /** Total `/compact` injections across the execution's lifetime. */
  compactAttempts: number;
  /**
   * True after a `/compact` was injected and we are waiting for the compacted
   * result to land before sending the "continue your work" nag. Guards against
   * re-injecting `/compact` while the old prompt-too-long result is still the
   * last persisted message.
   */
  awaitingContinue: boolean;
  lastActionAt: number | null;
}

export function createPromptTooLongRecoveryState(): PromptTooLongRecoveryState {
  return { compactAttempts: 0, awaitingContinue: false, lastActionAt: null };
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
