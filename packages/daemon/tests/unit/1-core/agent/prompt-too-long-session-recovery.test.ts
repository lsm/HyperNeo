/**
 * PromptTooLongSessionRecovery — general (non-space) session path.
 *
 * Covers the compact-then-continue state machine driven by discrete SDK result
 * messages: an overflow result injects `/compact` (at the queue head), a
 * subsequent successful result injects the continue nag, the resumed turn's
 * success result completes recovery, and repeated overflows OR non-overflow
 * errors are bounded by MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS. Detection and the
 * attempt cap are shared with the space-runtime path; the resume nag is
 * chat-specific.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import type { SDKMessage } from '@neokai/shared/sdk';
import { PromptTooLongSessionRecovery } from '../../../../src/lib/agent/prompt-too-long-session-recovery';
import type { Database } from '../../../../src/storage/database';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import { MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS } from '../../../../src/lib/space/runtime/prompt-too-long-recovery';

/** Kimi blocking_limit form: overflow phrase in the `result` field, no errors[]. */
function kimiPromptTooLongResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'Prompt is too long',
    terminal_reason: 'blocking_limit',
    errors: null,
  } as unknown as SDKMessage;
}

/** Anthropic-style terminal prompt_too_long result. */
function anthropicPromptTooLongResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'prompt_too_long',
    errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
  } as unknown as SDKMessage;
}

function successResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'All done.',
    terminal_reason: 'completed',
    errors: null,
  } as unknown as SDKMessage;
}

/** A non-overflow ERROR result (e.g. auth/rate-limit/model failure) after /compact. */
function nonOverflowErrorResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Rate limit exceeded',
    terminal_reason: 'error_max_budget_usd',
    errors: ['rate limited'],
  } as unknown as SDKMessage;
}

const CHAT_CONTINUE_NAG =
  '[Runtime recovery notice]\n\nYour conversation context exceeded the model window and was automatically compacted.\n' +
  "The context has been reduced. Please continue what you were doing, or answer the user's last message from the current state.";

interface RecoveryFixture {
  recovery: PromptTooLongSessionRecovery;
  enqueueWithId: ReturnType<typeof mock>;
  updateMessageStatus: ReturnType<typeof mock>;
  saveUserMessage: ReturnType<typeof mock>;
}

function makeRecovery(
  saveUserMessage: ReturnType<typeof mock> = mock(() => 'db-id'),
  enqueueWithId: ReturnType<typeof mock> = mock(async () => {})
): RecoveryFixture {
  const updateMessageStatus = mock(() => {});
  const messageQueue = {
    enqueueWithId,
  } as unknown as import('../../../../src/lib/agent/message-queue').MessageQueue;
  const db = { saveUserMessage, updateMessageStatus } as unknown as Database;
  const recovery = new PromptTooLongSessionRecovery({
    sessionId: 'chat-session-1',
    db,
    messageQueue,
  });
  return { recovery, enqueueWithId, updateMessageStatus, saveUserMessage };
}

describe('PromptTooLongSessionRecovery', () => {
  let recovery: PromptTooLongSessionRecovery;
  let enqueueWithId: ReturnType<typeof mock>;
  let updateMessageStatus: ReturnType<typeof mock>;
  let saveUserMessage: ReturnType<typeof mock>;

  beforeEach(() => {
    ({ recovery, enqueueWithId, updateMessageStatus, saveUserMessage } = makeRecovery());
  });

  describe('compact then continue', () => {
    it('injects /compact (persisted + enqueued at head) on a Kimi blocking_limit result', () => {
      expect(recovery.isActive()).toBe(false);

      recovery.handleResultMessage(kimiPromptTooLongResult());

      // Persisted as an enqueued system-origin user message, then queued at the HEAD.
      expect(saveUserMessage).toHaveBeenCalledTimes(1);
      expect(saveUserMessage.mock.calls[0][2]).toBe('enqueued');
      expect(saveUserMessage.mock.calls[0][3]).toBe('system');
      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(enqueueWithId.mock.calls[0][3]).toBe(true); // atHead
      expect(recovery.isActive()).toBe(true);
    });

    it('injects /compact on an Anthropic prompt_too_long terminal result', () => {
      recovery.handleResultMessage(anthropicPromptTooLongResult());
      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });

    it('injects the chat continue nag after a successful compact result', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      enqueueWithId.mockClear();

      recovery.handleResultMessage(successResult()); // compaction succeeded

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe(CHAT_CONTINUE_NAG);
      expect(recovery.isActive()).toBe(true);
    });

    it('completes (resets) once the resumed turn produces a successful result', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      recovery.handleResultMessage(successResult()); // → continue nag
      enqueueWithId.mockClear();

      recovery.handleResultMessage(successResult()); // resumed turn succeeded

      expect(enqueueWithId).not.toHaveBeenCalled();
      expect(recovery.isActive()).toBe(false);
    });

    it('no-ops on an ordinary result while idle', () => {
      recovery.handleResultMessage(successResult());
      expect(enqueueWithId).not.toHaveBeenCalled();
      expect(saveUserMessage).not.toHaveBeenCalled();
      expect(recovery.isActive()).toBe(false);
    });
  });

  describe('non-overflow error handling', () => {
    it('re-compacts (does not nag) when the compact turn ends with a non-overflow error', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      enqueueWithId.mockClear();

      recovery.handleResultMessage(nonOverflowErrorResult()); // compaction failed

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact'); // re-compact, not the nag
      expect(recovery.isActive()).toBe(true);
    });

    it('re-compacts when the resumed turn ends with a non-overflow error', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      recovery.handleResultMessage(successResult()); // → continue nag
      enqueueWithId.mockClear();

      recovery.handleResultMessage(nonOverflowErrorResult()); // resume failed

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });
  });

  describe('re-overflow bounding', () => {
    it('re-compacts while the context still overflows, up to MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS', () => {
      expect(MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS).toBe(2);

      recovery.handleResultMessage(kimiPromptTooLongResult()); // compact #1
      expect(enqueueWithId).toHaveBeenCalledTimes(1);

      recovery.handleResultMessage(kimiPromptTooLongResult()); // still overflowing → compact #2
      expect(enqueueWithId).toHaveBeenCalledTimes(2);

      // Cap reached: the third consecutive overflow gives up instead of looping.
      recovery.handleResultMessage(kimiPromptTooLongResult());
      expect(enqueueWithId).toHaveBeenCalledTimes(2);
      expect(recovery.isActive()).toBe(false);
    });

    it('re-compacts when the resumed turn overflows again (attempts preserved across resume)', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // compact #1
      recovery.handleResultMessage(successResult()); // → continue nag
      enqueueWithId.mockClear();

      recovery.handleResultMessage(kimiPromptTooLongResult()); // resume overflowed → compact #2

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });

    it('resets compactAttempts after a completed episode so a new overflow recovers fresh', () => {
      // Complete a full episode.
      recovery.handleResultMessage(kimiPromptTooLongResult()); // compact #1
      recovery.handleResultMessage(successResult()); // → continue nag
      recovery.handleResultMessage(successResult()); // resumed turn succeeded → complete → reset
      expect(recovery.isActive()).toBe(false);

      // A new overflow starts a fresh episode (compactAttempts reset, not a give-up).
      enqueueWithId.mockClear();
      recovery.handleResultMessage(kimiPromptTooLongResult());

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears an in-flight recovery so subsequent ordinary results do not inject', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact, awaiting_compact
      expect(recovery.isActive()).toBe(true);
      enqueueWithId.mockClear();

      recovery.reset();

      expect(recovery.isActive()).toBe(false);
      recovery.handleResultMessage(successResult());
      expect(enqueueWithId).not.toHaveBeenCalled();
    });
  });

  describe('persistence failure', () => {
    it('aborts recovery when the compact message cannot be persisted', () => {
      const throwingSave = mock(() => {
        throw new Error('database is locked');
      });
      const failing = makeRecovery(throwingSave);

      failing.recovery.handleResultMessage(kimiPromptTooLongResult());

      expect(throwingSave).toHaveBeenCalledTimes(1);
      expect(failing.enqueueWithId).not.toHaveBeenCalled();
      expect(failing.recovery.isActive()).toBe(false);
    });
  });

  describe('consumption (live message queue)', () => {
    function userMessageText(content: unknown): string {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .map((block) =>
            block &&
            typeof block === 'object' &&
            'text' in block &&
            typeof (block as { text: unknown }).text === 'string'
              ? (block as { text: string }).text
              : ''
          )
          .join('');
      }
      return '';
    }

    function makeLiveRecovery(mq: MessageQueue): PromptTooLongSessionRecovery {
      return new PromptTooLongSessionRecovery({
        sessionId: 'chat-sess',
        db: {
          saveUserMessage: mock(() => 'id') as Database['saveUserMessage'],
          updateMessageStatus: mock(() => {}),
        } as unknown as Database,
        messageQueue: mq,
      });
    }

    // The SDK runs in streaming-input mode (query({ prompt: AsyncIterable<SDKUserMessage> })),
    // so a single query stays open across turns and the message generator keeps yielding
    // enqueued user messages as the next turn. This reproduces that contract with a REAL
    // MessageQueue + an active consumer.
    it('the injected /compact is consumed by the live message generator', async () => {
      const mq = new MessageQueue();
      mq.start();
      const consumed: string[] = [];
      const consumer = (async () => {
        for await (const { message, onSent } of mq.messageGenerator('chat-sess')) {
          const text = userMessageText(message.message?.content);
          consumed.push(text);
          onSent();
          if (text === '/compact') break;
        }
      })();

      makeLiveRecovery(mq).handleResultMessage(kimiPromptTooLongResult());

      await consumer;
      expect(consumed).toContain('/compact');
    });

    it('injects /compact AHEAD of a message already in the queue (prepended)', async () => {
      const mq = new MessageQueue();
      mq.start();
      // A user message is already queued (the user typed it during the overflow turn;
      // the SDK is mid-turn and has not pulled it yet).
      void mq.enqueue('user-followup');

      // The overflow result arrives and recovery prepends /compact ahead of it.
      makeLiveRecovery(mq).handleResultMessage(kimiPromptTooLongResult());

      // Only now does the SDK pull the next message (the turn has ended).
      const consumed: string[] = [];
      for await (const { message, onSent } of mq.messageGenerator('chat-sess')) {
        consumed.push(userMessageText(message.message?.content));
        onSent();
        if (consumed.length >= 2) break;
      }

      // /compact was prepended, so it is consumed before the already-queued user message.
      expect(consumed[0]).toBe('/compact');
      expect(consumed[1]).toBe('user-followup');
    });
  });

  describe('aborted injection cleanup', () => {
    it('resets recovery AND marks the persisted row failed when the enqueued message is rejected', async () => {
      const save = mock(() => 'recovery-db-id');
      const rejectingEnqueue = mock(() => Promise.reject(new Error('Interrupted by user')));
      const fixture = makeRecovery(save, rejectingEnqueue);

      fixture.recovery.handleResultMessage(kimiPromptTooLongResult());
      expect(fixture.recovery.isActive()).toBe(true); // phase set before the rejection lands

      // Drain the microtask queue so the rejected enqueue's .catch runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fixture.recovery.isActive()).toBe(false);
      // The persisted row is marked 'failed' so sendEnqueuedMessagesOnTurnEnd won't replay it.
      expect(fixture.updateMessageStatus).toHaveBeenCalledWith(['recovery-db-id'], 'failed');
    });
  });
});
