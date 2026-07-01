/**
 * PromptTooLongSessionRecovery — general (non-space) session path.
 *
 * Covers the compact-then-continue state machine driven by discrete SDK result
 * messages: an overflow result injects `/compact`, a subsequent non-overflow
 * result injects the "continue your work" nag, the resumed turn's result
 * completes recovery, and repeated overflows are bounded by
 * MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS. Detection/nag/cap are shared with the
 * space-runtime path, so these tests pin the contract the two paths share.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import type { SDKMessage } from '@neokai/shared/sdk';
import { PromptTooLongSessionRecovery } from '../../../../src/lib/agent/prompt-too-long-session-recovery';
import type { Database } from '../../../../src/storage/database';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import {
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
  buildPromptTooLongContinueNag,
} from '../../../../src/lib/space/runtime/prompt-too-long-recovery';

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

function makeRecovery(
  saveUserMessage: Database['saveUserMessage'] = mock(() => 'db-id') as Database['saveUserMessage']
): { recovery: PromptTooLongSessionRecovery; enqueueWithId: ReturnType<typeof mock> } {
  const enqueueWithId = mock(async () => {});
  const messageQueue = { enqueueWithId } as unknown as MessageQueue;
  const db = { saveUserMessage } as unknown as Database;
  const recovery = new PromptTooLongSessionRecovery({
    sessionId: 'chat-session-1',
    db,
    messageQueue,
  });
  return { recovery, enqueueWithId };
}

describe('PromptTooLongSessionRecovery', () => {
  let recovery: PromptTooLongSessionRecovery;
  let enqueueWithId: ReturnType<typeof mock>;
  let saveUserMessage: ReturnType<typeof mock>;

  beforeEach(() => {
    saveUserMessage = mock(() => 'db-id');
    ({ recovery, enqueueWithId } = makeRecovery(saveUserMessage));
  });

  describe('compact then continue', () => {
    it('injects /compact (persisted + enqueued) on a Kimi blocking_limit result', () => {
      expect(recovery.isActive()).toBe(false);

      recovery.handleResultMessage(kimiPromptTooLongResult());

      // Persisted as an enqueued system-origin user message, then queued.
      expect(saveUserMessage).toHaveBeenCalledTimes(1);
      expect(saveUserMessage.mock.calls[0][2]).toBe('enqueued');
      expect(saveUserMessage.mock.calls[0][3]).toBe('system');
      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });

    it('injects /compact on an Anthropic prompt_too_long terminal result', () => {
      recovery.handleResultMessage(anthropicPromptTooLongResult());
      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe('/compact');
      expect(recovery.isActive()).toBe(true);
    });

    it('injects the continue nag after a successful compact result', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      enqueueWithId.mockClear();

      recovery.handleResultMessage(successResult()); // compaction succeeded

      expect(enqueueWithId).toHaveBeenCalledTimes(1);
      expect(enqueueWithId.mock.calls[0][1]).toBe(buildPromptTooLongContinueNag());
      expect(recovery.isActive()).toBe(true);
    });

    it('completes (resets) once the resumed turn produces a non-overflow result', () => {
      recovery.handleResultMessage(kimiPromptTooLongResult()); // → /compact
      recovery.handleResultMessage(successResult()); // → continue nag
      enqueueWithId.mockClear();

      recovery.handleResultMessage(successResult()); // resumed turn done

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
      const { recovery: failing, enqueueWithId: failingEnqueue } = makeRecovery(
        throwingSave as unknown as Database['saveUserMessage']
      );

      failing.handleResultMessage(kimiPromptTooLongResult());

      expect(throwingSave).toHaveBeenCalledTimes(1);
      expect(failingEnqueue).not.toHaveBeenCalled();
      expect(failing.isActive()).toBe(false);
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

    // The SDK runs in streaming-input mode (query({ prompt: AsyncIterable<SDKUserMessage> })),
    // so a single query stays open across turns and the message generator keeps yielding
    // enqueued user messages as the next turn. This reproduces that contract with a REAL
    // MessageQueue + an active consumer and proves the injected /compact is consumed by the
    // live generator (it drives a new turn) rather than stranded in a stopped queue.
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

      const recovery = new PromptTooLongSessionRecovery({
        sessionId: 'chat-sess',
        db: {
          saveUserMessage: mock(() => 'id') as Database['saveUserMessage'],
        } as unknown as Database,
        messageQueue: mq,
      });

      recovery.handleResultMessage(kimiPromptTooLongResult());

      await consumer;

      expect(consumed).toContain('/compact');
    });

    it('aborts in-flight recovery when the enqueued message is rejected (interrupt/clear)', async () => {
      const rejectingEnqueue = mock(() => Promise.reject(new Error('Interrupted by user')));
      const recovery = new PromptTooLongSessionRecovery({
        sessionId: 'chat-sess',
        db: {
          saveUserMessage: mock(() => 'id') as Database['saveUserMessage'],
        } as unknown as Database,
        messageQueue: { enqueueWithId: rejectingEnqueue } as unknown as MessageQueue,
      });

      recovery.handleResultMessage(kimiPromptTooLongResult());
      expect(recovery.isActive()).toBe(true); // phase set before the rejection lands

      // Drain the microtask queue so the rejected enqueue's .catch resets the phase.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(recovery.isActive()).toBe(false);
    });
  });
});
